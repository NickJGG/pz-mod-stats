// Fetches each mod's Steam Workshop comments, runs a LOCAL LLM (llama-server) over
// them to extract JIRA-style issues, reconciles against the previous run, and
// writes data/issues.js for audit.html to read. Run by hand: node scripts/audit.mjs.
//
// Everything stays on this machine: the model and the generated data never leave
// it, and data/issues.js is gitignored (data/ already is). Structure mirrors
// scripts/fetch.mjs — Node built-ins + global fetch only, mods.json as the single
// source of the mod list, read-old-file → update → write.
//
// Steam sends no CORS headers on the comment endpoint, which is why the fetch has
// to happen here in Node rather than in the browser.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ISSUES_OUT = resolve(ROOT, "data/issues.js");

// Every tracked mod belongs to the same account, so the comment endpoint's owner
// segment is one constant (resolved once from vanity /id/nick354).
const OWNER = "76561198042022681";
const LLAMA = "http://127.0.0.1:8080/v1/chat/completions";
const LLAMA_MODELS = "http://127.0.0.1:8080/v1/models";
const START_HINT = "start llama-server via C:\\Users\\Nick\\AI\\START.bat first";

const modUrl = (id) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;

const now = () => Math.floor(Date.now() / 1000);

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

    out.push({ id, author, authorUrl, date, text, permalink: `${url}#c${id}` });
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
  "came from.";

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
            required: ["type", "title", "summary", "sourceCommentIds"],
            properties: {
              type: { type: "string", enum: ["bug", "feature", "question", "compat", "other"] },
              title: { type: "string" },
              summary: { type: "string" },
              sourceCommentIds: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  },
};

async function extractIssues(short, comments) {
  const listing = comments
    .map((c) => `[${c.id}] ${c.author} (${new Date(c.date * 1000).toISOString().slice(0, 10)}): ${c.text}`)
    .join("\n\n");

  const body = JSON.stringify({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Comments for mod "${short}":\n\n${listing}` },
    ],
    temperature: 0.2,
    // "low" is the least reasoning the Qwen3.8 template allows ("none" is not a
    // valid level — it raises). Harmless here: llama-server puts reasoning in a
    // separate reasoning_content channel, so response_format still constrains
    // message.content to clean JSON regardless.
    chat_template_kwargs: { reasoning_effort: "low" },
    response_format: RESPONSE_FORMAT,
  });

  // The first inference of a run drops the socket while the model warms; a
  // network throw retries, an HTTP error (e.g. 400 bad request) does not.
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(LLAMA, { method: "POST", headers: { "content-type": "application/json" }, body });
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!res.ok) throw new Error(`llama chat HTTP ${res.status}`);

  const content = (await res.json())?.choices?.[0]?.message?.content ?? "{}";
  return JSON.parse(content).issues ?? [];
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

// ---- main ----------------------------------------------------------------

async function main() {
  await preflight();

  const config = JSON.parse(await readFile(resolve(ROOT, "mods.json"), "utf8"));
  const prior = await loadPrior();
  const priorByComment = priorIndex(prior);

  const modsMap = {};
  const issues = [];

  for (const mod of config.mods) {
    modsMap[mod.id] = { short: mod.short, slot: mod.slot, url: modUrl(mod.id) };

    let comments;
    try {
      comments = await fetchComments(mod.id);
    } catch (err) {
      console.warn(`${mod.short}: comment fetch failed (${err.message}) — skipped`);
      continue;
    }
    if (!comments.length) {
      console.log(`${mod.short}: no comments`);
      continue;
    }

    const byId = new Map(comments.map((c) => [c.id, c]));

    let raw;
    try {
      raw = await extractIssues(mod.short, comments);
    } catch (err) {
      console.warn(`${mod.short}: LLM extraction failed (${err.message}) — skipped`);
      continue;
    }

    for (const issue of raw) {
      const sourceComments = (issue.sourceCommentIds ?? [])
        .map((cid) => byId.get(String(cid)))
        .filter(Boolean)
        .map((c) => ({ id: c.id, author: c.author, text: c.text, permalink: c.permalink, date: c.date }));
      if (!sourceComments.length) continue; // cited nothing real — drop it

      const dates = sourceComments.map((c) => c.date).filter(Boolean);
      const lastSeen = dates.length ? Math.max(...dates) : 0;
      const derivedFirst = dates.length ? Math.min(...dates) : 0;

      const match = sourceComments.map((c) => priorByComment.get(c.id)).find(Boolean);

      issues.push({
        id: match?.id ?? randomUUID(),
        mod: mod.id,
        type: issue.type,
        title: issue.title,
        summary: issue.summary,
        sourceComments,
        reportCount: sourceComments.length,
        firstSeen: match?.firstSeen ?? derivedFirst,
        lastSeen,
        isNew: !match,
      });
    }
    console.log(`${mod.short}: ${comments.length} comments → ${raw.length} issues`);
  }

  issues.sort((a, b) => b.reportCount - a.reportCount);

  const payload = { generated: now(), mods: modsMap, issues };
  await mkdir(dirname(ISSUES_OUT), { recursive: true });
  await writeFile(ISSUES_OUT, `window.ISSUES = ${JSON.stringify(payload)};\n`);
  console.log(`data/issues.js written — ${issues.length} issues across ${config.mods.length} mods`);
}

await main();
