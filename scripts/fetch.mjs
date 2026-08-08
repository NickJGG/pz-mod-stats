// Polls the Steam Workshop for each mod in mods.json and appends a sample to
// data/history.json. Run by .github/workflows/poll.yml on a cron; the workflow
// only commits when this script actually changes the file.
//
// Two Steam endpoints are in play:
//
//   ISteamRemoteStorage/GetPublishedFileDetails  — no key, gives subscriptions,
//     favorites, views and their lifetime counters.
//   IPublishedFileService/GetDetails             — needs a Web API key, and is
//     the ONLY way to get vote data (the star rating). Skipped when
//     STEAM_API_KEY is unset, which leaves up/down null for that sample.
//
// Neither endpoint sends CORS headers, which is the whole reason the fetch
// happens here in CI instead of in the browser.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY = resolve(ROOT, "data/history.json");

// Append a sample even when nothing moved, this often, so the page can prove it
// is still being checked rather than silently wedged.
const HEARTBEAT_HOURS = 6;
// Samples older than this get thinned to one per UTC day.
const FULL_RES_DAYS = 45;

const FIELDS = ["t", "subs", "favs", "views", "lifeSubs", "lifeFavs", "up", "down"];

const now = () => Math.floor(Date.now() / 1000);

async function getDetails(ids) {
  const body = new URLSearchParams({ itemcount: String(ids.length) });
  ids.forEach((id, i) => body.set(`publishedfileids[${i}]`, id));

  const res = await fetch(
    "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
    { method: "POST", body },
  );
  if (!res.ok) throw new Error(`GetPublishedFileDetails HTTP ${res.status}`);

  const json = await res.json();
  const list = json?.response?.publishedfiledetails;
  if (!Array.isArray(list)) throw new Error("GetPublishedFileDetails: unexpected shape");
  return new Map(list.map((d) => [d.publishedfileid, d]));
}

// Returns id -> {up, down}. Any failure here is non-fatal: the rating is a
// bonus, and losing it must not cost us the sample we can collect keylessly.
async function getVotes(ids, key) {
  if (!key) return new Map();

  const qs = new URLSearchParams({ key, includevotes: "true" });
  ids.forEach((id, i) => qs.set(`publishedfileids[${i}]`, id));

  try {
    const res = await fetch(
      `https://api.steampowered.com/IPublishedFileService/GetDetails/v1/?${qs}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const list = (await res.json())?.response?.publishedfiledetails ?? [];
    return new Map(
      list
        .filter((d) => d.vote_data)
        .map((d) => [d.publishedfileid, {
          up: d.vote_data.votes_up ?? 0,
          down: d.vote_data.votes_down ?? 0,
        }]),
    );
  } catch (err) {
    console.warn(`vote data unavailable (${err.message}) — recording without ratings`);
    return new Map();
  }
}

async function loadHistory() {
  try {
    return JSON.parse(await readFile(HISTORY, "utf8"));
  } catch {
    return { updated: 0, fields: FIELDS, mods: {}, order: [], series: {} };
  }
}

// One-per-UTC-day past the full-resolution window. Keeps the last sample of each
// old day, which is the one whose numbers the day ended on.
function compact(rows) {
  const cutoff = now() - FULL_RES_DAYS * 86400;
  const recent = rows.filter((r) => r[0] >= cutoff);
  const daily = new Map();
  for (const r of rows) {
    if (r[0] >= cutoff) continue;
    daily.set(Math.floor(r[0] / 86400), r); // later rows overwrite earlier ones
  }
  return [...daily.values(), ...recent].sort((a, b) => a[0] - b[0]);
}

const sameNumbers = (a, b) =>
  a && b && a.length === b.length && a.every((v, i) => i === 0 || v === b[i]);

async function main() {
  const config = JSON.parse(await readFile(resolve(ROOT, "mods.json"), "utf8"));
  const ids = config.mods.map((m) => m.id);

  const [details, votes] = await Promise.all([
    getDetails(ids),
    getVotes(ids, process.env.STEAM_API_KEY),
  ]);

  const history = await loadHistory();
  history.fields = FIELDS;
  history.order = ids;

  const t = now();
  let changed = false;

  for (const mod of config.mods) {
    const d = details.get(mod.id);
    if (!d || d.result !== 1) {
      console.warn(`${mod.short}: no details returned (result ${d?.result}) — skipped`);
      continue;
    }

    history.mods[mod.id] = {
      title: d.title,
      short: mod.short,
      slot: mod.slot,
      created: d.time_created,
      updated: d.time_updated,
      url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.id}`,
    };

    const v = votes.get(mod.id);
    const row = [
      t,
      d.subscriptions ?? 0,
      d.favorited ?? 0,
      d.views ?? 0,
      d.lifetime_subscriptions ?? 0,
      d.lifetime_favorited ?? 0,
      v ? v.up : null,
      v ? v.down : null,
    ];

    const rows = (history.series[mod.id] ??= []);
    const last = rows[rows.length - 1];
    const stale = !last || t - last[0] >= HEARTBEAT_HOURS * 3600;

    if (!sameNumbers(row, last) || stale) {
      rows.push(row);
      history.series[mod.id] = compact(rows);
      changed = true;
      console.log(`${mod.short}: ${row[1]} subs · ${row[2]} favs · ${row[3]} views`);
    } else {
      console.log(`${mod.short}: unchanged`);
    }
  }

  if (!changed) {
    console.log("nothing to record");
    return;
  }

  history.updated = t;
  await mkdir(dirname(HISTORY), { recursive: true });
  await writeFile(HISTORY, JSON.stringify(history) + "\n");
  console.log("history.json written");
}

await main();
