// Fetches each mod's Steam Workshop comments, runs a LOCAL LLM (llama-server) over
// them to extract JIRA-style issues, reconciles against the previous run, writes
// data/issues.js for audit.html, and force-pushes it to the audit-data branch so
// the deployed page can read it. Run by hand: node scripts/audit.mjs (--no-publish
// to skip the push).
//
// The model and raw comments stay on this machine; only the finished triage is
// published. data/issues.js is gitignored (data/ already is), so the push goes to
// its own orphan branch rather than master. Structure mirrors scripts/fetch.mjs —
// Node built-ins + global fetch only, mods.json as the single source of the mod
// list, read-old-file → update → write.
//
// Steam sends no CORS headers on the comment endpoint, which is why the fetch has
// to happen here in Node rather than in the browser.

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ISSUES_OUT = resolve(ROOT, "data/issues.js");

// Its own lane, not `stats-data`: the 5-min poller rebuilds that branch from
// history.json alone and would wipe issues.js. audit.html reads the same name.
const AUDIT_BRANCH = "audit-data";

// Every tracked mod belongs to the same account, so the comment endpoint's owner
// segment is one constant (resolved once from vanity /id/nick354).
const OWNER = "76561198042022681";
// A comment is the mod author's if its profile link is the owner's, in either the
// numeric or vanity form Steam may render.
const OWNER_URL_FRAGMENTS = [`/profiles/${OWNER}`, "/id/nick354"];
const LLAMA = "http://127.0.0.1:8080/v1/chat/completions";
const LLAMA_MODELS = "http://127.0.0.1:8080/v1/models";
const START_HINT = "start llama-server via C:\\Users\\Nick\\AI\\START.bat first";

// How many mods are triaged at once. Set to 1: this GPU is already compute-bound
// on a single request, so batching two sequences roughly halved each one's speed
// and the ~2× overlap only broke even (worse, once draft-mtp speculation lost its
// spare compute). The pool machinery stays so this is a one-line re-enable — but
// it only pays off on hardware with idle capacity, and MUST stay ≤ llama-server's
// -np in START.bat or the extra requests just queue on the server.
const CONCURRENCY = 1;

// `--no-think` disables the model's chain-of-thought. On a compute-bound GPU the
// CoT is the bulk of the tokens generated per mod, so dropping it is the only
// lever that actually shortens the work rather than reshuffling it. Safe-ish here
// because reconcileStatus already re-judges resolution in code — the reasoning's
// main product is second-guessed anyway. Whether clustering quality holds is the
// open question, so keep it a flag and diff the output before trusting it.
const THINK = !process.argv.includes("--no-think");

const modUrl = (id) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;

const now = () => Math.floor(Date.now() / 1000);

// ---- live console ---------------------------------------------------------
// Mods run concurrently, so a single \r status line can't work — two slots would
// fight over one row. The board owns the bottom H rows of the terminal (H = pool
// width): each in-flight slot is one row redrawn in place, while completed mods
// scroll up as permanent lines above it. Cursor invariant: it always rests at
// column 0 on the line directly below the board. When stdout is redirected
// (piped, CI) the board is silent and only the permanent lines print.

const isTTY = process.stdout.isTTY;
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
let spinI = 0;
const spin = () => SPIN[spinI++ % SPIN.length];

// Trim a live row to the terminal width so it can't wrap — a wrapped row spans
// two physical lines and throws off the cursor-up count the board relies on. SGR
// escapes are copied through at zero width, and a reset is appended so a clipped
// row never leaves colour bleeding into the next.
const clip = (s) => {
  const cols = (process.stdout.columns || 120) - 1;
  let vis = 0;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\x1b") {
      const j = s.indexOf("m", i);
      if (j >= 0) { out += s.slice(i, j + 1); i = j; continue; }
    }
    if (vis >= cols) break;
    out += s[i];
    vis++;
  }
  return `${out}\x1b[0m`;
};

// \x1b[2K clears a row; \x1b[{n}A moves the cursor up n rows; \x1b[1A up one.
function makeBoard(height) {
  const rows = Array(height).fill("");
  let drawn = false;
  const paint = () => {
    for (let i = 0; i < height; i++) process.stdout.write(`\x1b[2K${rows[i]}\n`);
  };
  return {
    // Set slot k's live row and repaint the board where it stands.
    set(k, text) {
      if (!isTTY) return;
      rows[k] = clip(text);
      if (!drawn) { paint(); drawn = true; }
      else { process.stdout.write(`\x1b[${height}A\r`); paint(); }
    },
    // Blank a drained slot's row (worker has no more mods to run).
    clear(k) { this.set(k, ""); },
    // Emit a permanent line above the board: erase the board upward, print the
    // line where its top row was, then repaint the board one row lower.
    log(text) {
      if (!isTTY) { console.log(text.trim()); return; }
      if (!drawn) { process.stdout.write(`${text}\n`); return; }
      for (let i = 0; i < height; i++) process.stdout.write("\x1b[1A\x1b[2K");
      process.stdout.write(`${text}\n`);
      paint();
    },
    // Erase the board region entirely at end of run.
    close() {
      if (!isTTY || !drawn) return;
      for (let i = 0; i < height; i++) process.stdout.write("\x1b[1A\x1b[2K");
      drawn = false;
    },
  };
}

// ---- Step 0: preflight ---------------------------------------------------

async function preflight() {
  try {
    const res = await fetch(LLAMA_MODELS);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(`llama-server unreachable (${err.message}) — ${START_HINT}`);
    process.exit(1);
  }
}

// ---- Step 1: fetch + parse comments --------------------------------------

const decodeEntities = (s) =>
  s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, "&")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

// Regex over Steam's stable comment markup. If Steam ever restructures it, these
// per-field patterns are the single place to fix.
function parseComments(html, url) {
  const out = [];
  const marks = [];
  const re = /id="comment_(\d+)"/g;
  let m;
  while ((m = re.exec(html))) marks.push({ id: m[1], idx: m.index });

  for (let i = 0; i < marks.length; i++) {
    const { id } = marks[i];
    const block = html.slice(marks[i].idx, i + 1 < marks.length ? marks[i + 1].idx : html.length);

    const rawText = block.match(/commentthread_comment_text[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "";
    const text = decodeEntities(rawText);
    if (!text) continue; // dropped empty/deleted

    const authorUrl = block.match(/commentthread_author_link[^>]*?href="([^"]+)"/i)?.[1] ?? "";
    const author = decodeEntities(
      block.match(/commentthread_author_link[^>]*>[\s\S]*?<bdi>([\s\S]*?)<\/bdi>/i)?.[1] ?? "",
    ) || "Unknown";
    const date = Number(block.match(/commentthread_comment_timestamp[^>]*data-timestamp="(\d+)"/i)?.[1] ?? 0);
    const isOwner = OWNER_URL_FRAGMENTS.some((f) => authorUrl.includes(f));

    out.push({ id, author, authorUrl, date, text, isOwner, permalink: `${url}#c${id}` });
  }
  return out;
}

async function fetchComments(id) {
  const url = modUrl(id);
  const collected = [];
  let start = 0;
  const count = 100;

  for (;;) {
    const res = await fetch(
      `https://steamcommunity.com/comment/PublishedFile_Public/render/${OWNER}/${id}/?start=${start}&count=${count}`,
    );
    if (!res.ok) throw new Error(`comment render HTTP ${res.status}`);
    const json = await res.json();
    if (!json?.success) throw new Error("comment render: success=false");

    collected.push(...parseComments(json.comments_html ?? "", url));
    const total = json.total_count ?? collected.length;
    start += count;
    if (start >= total || !json.comments_html) break;
  }
  return collected;
}

// ---- Step 2: LLM extraction ----------------------------------------------

const SYSTEM_PROMPT =
  "You triage Steam Workshop mod comments into issues. Cluster comments reporting " +
  "the same thing into ONE issue. Drop pure praise/thanks and off-topic chatter. " +
  "`question` = a user asking whether/how the mod does something (signals a missing " +
  "feature or a description gap). Every issue must cite the `sourceCommentIds` it " +
  "came from.\n\n" +
  "Also judge whether each issue is resolved, and be conservative — default to " +
  "`open`. Use `resolved` ONLY when a comment tagged `(MOD AUTHOR)` says the issue " +
  "is fixed, is intended behaviour, or won't be fixed. Use `likely-resolved` ONLY " +
  "when a non-author user clearly reports it is solved or worked around. When in " +
  "doubt, `open`. For a non-open issue set `resolvingCommentId` to the id of the " +
  "comment that establishes resolution and `resolutionNote` to a short reason " +
  "(e.g. \"owner: fixed in build 42.9\"); leave both empty for `open`.";

// Object root (not a bare array) so the OpenAI-compatible json_schema wrapper is
// happy; llama-server compiles it to GBNF and the output is guaranteed valid JSON.
const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "issues",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["issues"],
      properties: {
        issues: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["type", "title", "summary", "sourceCommentIds", "status", "resolutionNote", "resolvingCommentId"],
            properties: {
              type: { type: "string", enum: ["bug", "feature", "question", "compat", "other"] },
              title: { type: "string" },
              summary: { type: "string" },
              sourceCommentIds: { type: "array", items: { type: "string" } },
              status: { type: "string", enum: ["open", "resolved", "likely-resolved"] },
              resolutionNote: { type: "string" },
              resolvingCommentId: { type: "string" },
            },
          },
        },
      },
    },
  },
};

async function extractIssues(short, comments, onTick) {
  const listing = comments
    .map(
      (c) =>
        `[${c.id}] ${c.author}${c.isOwner ? " (MOD AUTHOR)" : ""} ` +
        `(${new Date(c.date * 1000).toISOString().slice(0, 10)}): ${c.text}`,
    )
    .join("\n\n");

  const body = JSON.stringify({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Comments for mod "${short}":\n\n${listing}` },
    ],
    temperature: 0.2,
    // Thinking on: "low" is the least reasoning the Qwen3.8 template allows
    // ("none" raises). Off: `enable_thinking: false` is Qwen3's own switch —
    // llama-server keeps reasoning in a separate reasoning_content channel either
    // way, so response_format still constrains message.content to clean JSON.
    chat_template_kwargs: THINK ? { reasoning_effort: "low" } : { enable_thinking: false },
    response_format: RESPONSE_FORMAT,
    stream: true,
  });

  // The whole attempt — connect and drain — is retried, because the first
  // inference of a run drops the socket while the model warms, and with streaming
  // that shows up mid-drain as often as at connect. An HTTP error (e.g. 400) is
  // marked fatal so it throws straight out instead of retrying a bad request.
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(LLAMA, { method: "POST", headers: { "content-type": "application/json" }, body });
      if (!res.ok) throw Object.assign(new Error(`llama chat HTTP ${res.status}`), { fatal: true });

      const started = Date.now();
      const decoder = new TextDecoder();
      let buf = "";
      let reason = ""; // the model's chain-of-thought channel (streams first)
      let content = ""; // the GBNF-constrained JSON answer (streams after)
      let tokens = 0;
      let timings = null;

      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let obj;
          try {
            obj = JSON.parse(data);
          } catch {
            continue; // a split SSE frame; the rest arrives in the next chunk
          }
          if (obj.timings) timings = obj.timings;
          const delta = obj.choices?.[0]?.delta ?? {};
          if (delta.reasoning_content) { reason += delta.reasoning_content; tokens++; }
          if (delta.content) { content += delta.content; tokens++; }

          const elapsed = (Date.now() - started) / 1000;
          const src = content || reason; // once the answer starts, show it, not the thinking
          onTick?.({
            phase: content ? "writing" : "thinking",
            tokens,
            tps: tokens / Math.max(elapsed, 0.001),
            elapsed,
            tail: src.replace(/\s+/g, " ").slice(-48),
          });
        }
      }

      const elapsed = (Date.now() - started) / 1000;
      return {
        issues: JSON.parse(content || "{}").issues ?? [],
        tokens: timings?.predicted_n ?? tokens,
        tps: timings?.predicted_per_second ?? tokens / Math.max(elapsed, 0.001),
        elapsed,
      };
    } catch (err) {
      if (err.fatal || attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ---- Step 3: assemble + reconcile ----------------------------------------

// Prior issues indexed by every sourceCommentId they cite, for the overlap match.
function priorIndex(prior) {
  const byComment = new Map();
  for (const issue of prior) {
    for (const c of issue.sourceComments ?? []) {
      if (!byComment.has(c.id)) byComment.set(c.id, issue);
    }
  }
  return byComment;
}

// The reconcile keys on comment id, but old records only stored the permalink; the
// id is its `#c<id>` fragment. Backfill it so overlap matching works either way.
function withCommentIds(prior) {
  for (const issue of prior) {
    for (const c of issue.sourceComments ?? []) {
      if (!c.id) c.id = c.permalink?.match(/#c(\d+)/)?.[1] ?? "";
    }
  }
  return prior;
}

async function loadPrior() {
  try {
    const text = await readFile(ISSUES_OUT, "utf8");
    const json = text.slice(text.indexOf("=") + 1).trim().replace(/;\s*$/, "");
    return withCommentIds(JSON.parse(json).issues ?? []);
  } catch {
    return [];
  }
}

// Resolution is sticky: the local model re-judges every run, so a bare open/resolved
// flip is noise. Once prior is resolved/likely we keep it — only a NON-OWNER comment
// dated after the fix reopens (someone still hitting it; the author's own follow-up
// doesn't count). Upgrades (likely-resolved → resolved) are allowed, downgrades are
// not. A resolution the model can't date is distrusted back to `open`.
function reconcileStatus(issue, byId, match, sourceComments) {
  let status = issue.status ?? "open";
  const resolvedDate = status !== "open" ? byId.get(String(issue.resolvingCommentId))?.date ?? 0 : 0;
  let note = status !== "open" ? issue.resolutionNote ?? "" : "";
  if (status !== "open" && !resolvedDate) (status = "open"), (note = "");

  const prior = match?.status ?? "open";
  if (prior === "open") return { status, resolutionNote: note, resolvedDate };

  if (sourceComments.some((c) => c.date > (match.resolvedDate ?? 0) && !c.isOwner)) {
    return { status: "open", resolutionNote: "", resolvedDate: 0 };
  }
  if (prior === "likely-resolved" && status === "resolved") {
    return { status: "resolved", resolutionNote: note, resolvedDate };
  }
  return { status: prior, resolutionNote: match.resolutionNote ?? "", resolvedDate: match.resolvedDate ?? 0 };
}

// ---- Step 4: publish -----------------------------------------------------

function git(args, env) {
  return new Promise((res, rej) => {
    execFile("git", args, { cwd: ROOT, env: env ?? process.env, windowsHide: true }, (err, stdout, stderr) =>
      err ? rej(new Error(stderr?.trim() || err.message)) : res(stdout),
    );
  });
}

// Builds a parentless commit holding only data/issues.js and force-pushes it, so
// the branch is always exactly one commit deep — same shape as the poller's
// stats-data. Staging goes through a throwaway index (GIT_INDEX_FILE) so HEAD and
// the real index are never touched: publishing can't disturb work in progress.
async function publish() {
  const gitDir = (await git(["rev-parse", "--git-dir"])).trim();
  const tmpIndex = resolve(ROOT, gitDir, "audit-publish-index");
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    await git(["add", "--force", "data/issues.js"], env); // --force: data/ is gitignored
    const tree = (await git(["write-tree"], env)).trim();
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
    const commit = (await git(["commit-tree", tree, "-m", `audit: ${stamp} UTC`])).trim();
    // Fully-qualified dst: git won't create a branch from a bare name, so the
    // first push (before audit-data exists on the remote) needs refs/heads/.
    await git(["push", "--force", "origin", `${commit}:refs/heads/${AUDIT_BRANCH}`]);
    console.log(`published data/issues.js → ${AUDIT_BRANCH}`);
  } finally {
    await rm(tmpIndex, { force: true });
  }
}

// ---- main ----------------------------------------------------------------

async function main() {
  await preflight();
  console.log(`reasoning: ${THINK ? "on (low)" : "off"}`);

  const config = JSON.parse(await readFile(resolve(ROOT, "mods.json"), "utf8"));
  const prior = await loadPrior();
  const priorByComment = priorIndex(prior);

  const modsMap = {};
  const issues = [];
  const total = config.mods.length;
  const board = makeBoard(CONCURRENCY);

  let runTokens = 0;
  let runElapsed = 0; // summed model time across mods — with overlap it exceeds wall

  // One mod end to end on a given board slot. Concurrency-safe: the shared writes
  // are Map/array mutations between awaits (single-threaded, so atomic), and the
  // final issues.sort makes assembly order irrelevant.
  async function processMod(mod, i, slot) {
    const tag = `[${i + 1}/${total}] ${mod.short}`;
    modsMap[mod.id] = { short: mod.short, slot: mod.slot, url: modUrl(mod.id) };

    let comments;
    try {
      board.set(slot, `${spin()} ${tag}  fetching comments…`);
      comments = await fetchComments(mod.id);
    } catch (err) {
      board.log(`${tag} ✗ comment fetch failed (${err.message}) — skipped`);
      return;
    }
    if (!comments.length) {
      board.log(`${tag} (no comments)`);
      return;
    }

    const byId = new Map(comments.map((c) => [c.id, c]));

    let result;
    try {
      result = await extractIssues(mod.short, comments, (t) =>
        board.set(
          slot,
          `${spin()} ${tag}  ${t.phase.padEnd(8)} ${comments.length}c · ${t.tokens} tok · ` +
            `${t.tps.toFixed(0)} tok/s · ${t.elapsed.toFixed(1)}s  \x1b[2m${t.tail}\x1b[0m`,
        ),
      );
    } catch (err) {
      board.log(`${tag} ✗ LLM extraction failed (${err.message}) — skipped`);
      return;
    }
    const raw = result.issues;
    runTokens += result.tokens;
    runElapsed += result.elapsed;
    board.log(
      `${tag} → ${raw.length} issue${raw.length === 1 ? "" : "s"} · ${comments.length} comments · ` +
        `${result.tokens} tok · ${result.tps.toFixed(0)} tok/s · ${result.elapsed.toFixed(1)}s`,
    );

    // Build every candidate first, then reconcile identity across the whole mod at
    // once. A per-issue `.find` can't see that the model split one prior issue into
    // two this run (both would claim it) or merged two into one — and identity plus
    // resolved-status ride on the match, so a wrong match hides a live problem.
    const prepared = [];
    for (const issue of raw) {
      const sourceComments = (issue.sourceCommentIds ?? [])
        .map((cid) => byId.get(String(cid)))
        .filter(Boolean)
        .map((c) => ({ id: c.id, author: c.author, text: c.text, permalink: c.permalink, date: c.date, isOwner: c.isOwner }));
      if (!sourceComments.length) continue; // cited nothing real — drop it

      const overlap = new Map(); // prior issue -> how many of these comments it holds
      for (const c of sourceComments) {
        const p = priorByComment.get(c.id);
        if (p) overlap.set(p, (overlap.get(p) ?? 0) + 1);
      }
      let dominant = null, best = 0;
      for (const [p, n] of overlap) if (n > best) (best = n), (dominant = p);

      prepared.push({ issue, sourceComments, overlap, dominant, overlapCount: best });
    }

    // A prior's identity goes to the one candidate overlapping it most; ties keep the
    // first. Other candidates that also touched it (a split) fall through to a fresh
    // id below rather than duplicating the identity and its resolved flag.
    const winnerFor = new Map(); // prior.id -> winning candidate's issue object
    for (const p of prepared) {
      if (!p.dominant) continue;
      const cur = winnerFor.get(p.dominant.id);
      if (!cur || p.overlapCount > cur.overlapCount) winnerFor.set(p.dominant.id, p);
    }

    for (const { issue, sourceComments, overlap, dominant } of prepared) {
      const dates = sourceComments.map((c) => c.date).filter(Boolean);
      const lastSeen = dates.length ? Math.max(...dates) : 0;
      const derivedFirst = dates.length ? Math.min(...dates) : 0;

      const match = dominant && winnerFor.get(dominant.id)?.issue === issue ? dominant : null;
      let { status, resolutionNote, resolvedDate } = reconcileStatus(issue, byId, match, sourceComments);

      // Merge (this candidate absorbed >1 prior): it keeps the dominant prior's id,
      // but if ANY absorbed prior was still open, force open — a merge must never let
      // a resolved neighbour hide an open problem, which the page filters out of view.
      if (match && overlap.size > 1 && status !== "open" &&
          [...overlap.keys()].some((p) => (p.status ?? "open") === "open")) {
        (status = "open"), (resolutionNote = ""), (resolvedDate = 0);
      }

      // firstSeen spans every absorbed prior on a merge; a lone match keeps its own.
      let firstSeen = derivedFirst;
      if (match) {
        const firsts = [...overlap.keys()].map((p) => p.firstSeen).filter(Boolean);
        const ff = Math.min(...firsts, derivedFirst || Infinity);
        firstSeen = isFinite(ff) ? ff : derivedFirst;
      }

      issues.push({
        id: match?.id ?? randomUUID(),
        mod: mod.id,
        type: issue.type,
        // Sticky: a matched issue keeps its prior title so the label doesn't drift as
        // the model rephrases it run to run. summary/type stay fresh to track updates.
        title: match?.title ?? issue.title,
        summary: issue.summary,
        sourceComments,
        reportCount: sourceComments.length,
        firstSeen,
        lastSeen,
        isNew: !match,
        status,
        resolutionNote,
        resolvedDate,
      });
    }
  }

  // Fixed pool of CONCURRENCY workers pulling mods off a shared cursor; each owns
  // one board slot for its lifetime and blanks it once the queue is drained.
  const wall0 = Date.now();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, total) || 1 }, (_, slot) =>
      (async () => {
        for (;;) {
          const i = next++;
          if (i >= total) { board.clear(slot); return; }
          await processMod(config.mods[i], i, slot);
        }
      })(),
    ),
  );
  board.close();
  const wall = (Date.now() - wall0) / 1000;

  console.log(
    `${total} mods · ${runTokens} tok · ${runElapsed.toFixed(1)}s model · ${wall.toFixed(1)}s wall`,
  );

  issues.sort((a, b) => b.reportCount - a.reportCount);

  const payload = { generated: now(), mods: modsMap, issues };
  await mkdir(dirname(ISSUES_OUT), { recursive: true });
  await writeFile(ISSUES_OUT, `window.ISSUES = ${JSON.stringify(payload)};\n`);
  console.log(`data/issues.js written — ${issues.length} issues across ${config.mods.length} mods`);

  if (!process.argv.includes("--no-publish")) {
    // The local file is already written; a failed push loses nothing, so warn
    // rather than exit — a manual retry or `--no-publish` run still has the data.
    try {
      await publish();
    } catch (err) {
      console.error(`publish failed (${err.message}) — data/issues.js is written; re-run to retry`);
    }
  }
}

await main();
