// Live current numbers for the dashboard, fetched from Steam on request.
//
// Steam's API sends no CORS headers, which is why scripts/fetch.mjs has to run
// in CI — a browser can't call it from another origin. Served from the same
// origin as index.html, this function doesn't work around that problem so much
// as remove it: nothing is cross-origin, so no proxy headers are involved.
//
// This returns *current* values only. Steam has no historical endpoint (the API
// returns scalars — see the fields list in README), so accumulated history still
// comes from the stats-data branch. The page reads both.
//
// CommonJS and no package.json on purpose: Vercel picks up bare /api/*.js with
// zero config and no build step, which keeps this repo dependency-free.

const { mods } = require("../mods.json"); // one source of truth with the poller

const IDS = mods.map((m) => m.id);

// Same column order as a history.json row, so the page can splice what we return
// straight into its series without remapping fields.
const toRow = (t, d, v) => [
  t,
  d.subscriptions ?? 0,
  d.favorited ?? 0,
  d.views ?? 0,
  d.lifetime_subscriptions ?? 0,
  d.lifetime_favorited ?? 0,
  v ? v.up : null,
  v ? v.down : null,
];

async function getDetails() {
  const body = new URLSearchParams({ itemcount: String(IDS.length) });
  IDS.forEach((id, i) => body.set(`publishedfileids[${i}]`, id));

  const res = await fetch(
    "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
    { method: "POST", body },
  );
  if (!res.ok) throw new Error(`GetPublishedFileDetails HTTP ${res.status}`);

  const list = (await res.json())?.response?.publishedfiledetails;
  if (!Array.isArray(list)) throw new Error("GetPublishedFileDetails: unexpected shape");
  return new Map(list.filter((d) => d.result === 1).map((d) => [d.publishedfileid, d]));
}

// Ratings need a key. Failure here is non-fatal for the same reason it is in
// fetch.mjs: the stars are a bonus and must not cost us the numbers we can get
// without a key.
async function getVotes() {
  const key = process.env.STEAM_API_KEY;
  if (!key) return new Map();

  const qs = new URLSearchParams({ key, includevotes: "true" });
  IDS.forEach((id, i) => qs.set(`publishedfileids[${i}]`, id));

  try {
    const res = await fetch(
      `https://api.steampowered.com/IPublishedFileService/GetDetails/v1/?${qs}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = (await res.json())?.response?.publishedfiledetails ?? [];
    return new Map(
      list.filter((d) => d.vote_data).map((d) => [d.publishedfileid, {
        up: d.vote_data.votes_up ?? 0,
        down: d.vote_data.votes_down ?? 0,
      }]),
    );
  } catch {
    return new Map();
  }
}

module.exports = async function handler(req, res) {
  try {
    const [details, votes] = await Promise.all([getDetails(), getVotes()]);
    const t = Math.floor(Date.now() / 1000);

    const rows = {};
    for (const [id, d] of details) rows[id] = toRow(t, d, votes.get(id));

    // Served from Vercel's edge for 30s without re-invoking this function, so a
    // hundred open tabs still cost Steam one request per 30s — and cost us
    // almost no invocations. The page polls every 60s, so this is never stale
    // enough to matter.
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    res.status(200).json({ t, rows });
  } catch (err) {
    // 502, not 500: we're reporting that Steam failed us, not that we broke.
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: err.message });
  }
};
