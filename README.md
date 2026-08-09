# Workshop Stats

A self-updating dashboard for my Project Zomboid Workshop mods — subscribers,
favourites, views and ratings, on one page that refreshes itself.

**Live page:** https://nickjgg.github.io/pz-mod-stats/

## How it works

Steam's Workshop API sends no CORS headers, so a browser can't call it directly
from another origin. The fetch therefore happens in CI:

```
cron (5 min) ──▶ scripts/fetch.mjs ──▶ data/history.json ──▶ force-push
                                              ▲                    │
                                              └── stats-data branch ◀┘
                                                        │
        index.html (on Pages, from master) polls it every 60s via raw. ◀┘
```

`data/history.json` accumulates a sample every time a number moves, so the page
shows growth over time — something the Workshop itself never gives you.

**That file is not in the site, and not on `master`.** It lives alone on the
`stats-data` orphan branch, which the poller rebuilds as a parentless commit and
force-pushes each run. So it is always exactly one commit deep no matter how
many years of samples it holds, and 96 polls a day add nothing to `master`'s
history. The page reads it cross-origin from `raw.githubusercontent.com`, which
sends `access-control-allow-origin: *`; `index.html` derives the owner and repo
from the Pages hostname, so nothing hardcodes the account.

The trade is that there's no per-sample audit trail — the branch remembers the
current file, not how it got there. Given the file *is* the history, that costs
nothing real. But it does mean a bad force-push has no `git` undo, which is why
the workflow's restore step aborts rather than continuing from an empty history
if it can't read the branch it's about to overwrite.

## Live numbers

The poller above records history. It can't make the page *fresh*, because
GitHub's cron floor is 5 minutes and Steam's counters move every 1–3 minutes
when a mod is active. So current values come from a second source:

```
browser ──▶ /api/stats (same origin) ──▶ Steam ──▶ back, uncached after 30s
```

`api/stats.js` is a Vercel Serverless Function. Being same-origin is the whole
trick — the CORS problem that forces the poller into CI doesn't apply, because
nothing is cross-origin. It returns rows in exactly the `fields` order used by
`history.json`, so `index.html` splices them in at `latest()` and every tile,
delta and table cell picks them up without the render code knowing there are two
sources. Charts and baselines deliberately keep using recorded history.

If the function isn't there — a plain GitHub Pages deployment, say — the page
notices the first 404 and silently falls back to history-only. Nothing breaks.

`Cache-Control: s-maxage=30` means Vercel's edge answers most requests without
invoking the function, so a hundred open tabs still cost Steam one call per 30
seconds. That's what keeps this inside the free tier; don't remove it.

**Deploying:** point Vercel at this repo. It serves `index.html` statically and
picks up `/api` automatically — no `package.json`, no build step, no config.
Set `STEAM_API_KEY` in the project's environment variables if you want live star
ratings; without it, `up`/`down` come back null exactly as they do in CI.

Note that `DATA_REPO` in `index.html` is hardcoded, because once the page is
served from Vercel there's no `github.io` hostname left to derive it from.

Two Steam endpoints are involved:

| Endpoint | Key? | Gives |
|---|---|---|
| `ISteamRemoteStorage/GetPublishedFileDetails` | no | subscriptions, favourites, views, lifetime counters |
| `IPublishedFileService/GetDetails` | **yes** | vote data (the star rating) |

Without `STEAM_API_KEY` set, everything but the rating still records.

## Setup

1. **Create a public repo** named `pz-mod-stats` and push this directory to it.
   Public matters: GitHub Pages on a private repo needs a paid plan.

2. **Enable Pages** — Settings → Pages → Source: *Deploy from a branch*,
   branch `master`, folder `/ (root)`. Leave it on `master`; the poller's
   `stats-data` branch is data only and is never served by Pages.

3. **Add the rating key** (optional) — grab one at
   <https://steamcommunity.com/dev/apikey> (domain can be anything), then
   Settings → Secrets and variables → Actions → New repository secret,
   named `STEAM_API_KEY`.

4. **Kick it off** — Actions → *Poll workshop stats* → Run workflow. The first
   run creates the `stats-data` branch; until it does, the page will say it
   can't load the history. After that the cron takes over.

The page works on a phone; "Add to Home Screen" gives it an icon and opens it
without browser chrome.

## Adding a mod

Append to `mods.json` with the next free `slot`:

```json
{ "id": "1234567890", "short": "Display Name", "slot": 4 }
```

`slot` fixes the chart colour to the mod, so reordering or removing entries
never repaints the others. Slots map to the categorical palette in
`index.html` (`--s1`…`--s3`); add a `--s4` token if you go past three.

## Notes

- Scheduled workflows are disabled after 60 days of repository inactivity. The
  poller's own pushes to `stats-data` should count, but if it ever goes quiet,
  push anything and re-enable the workflow in the Actions tab.
- The poll runs every 5 minutes, which is GitHub's documented floor for
  `schedule:` — and runs are queued best-effort on top of that, so it's a floor,
  not a promise. It was `*/15` until the data moved off `master`, purely because
  each sample was a commit and so a Pages rebuild against the ~10 builds/hour
  soft limit. Nothing rebuilds now, so 5 is simply the fastest cron GitHub
  offers. Going below it means polling from outside Actions.
- Old samples are thinned to one per day after 45 days to keep the file small.
- `python tools/make_icons.py` regenerates the home-screen icons.
