# Workshop Stats

A self-updating dashboard for my Project Zomboid Workshop mods — subscribers,
favourites, views and ratings, on one page that refreshes itself.

**Live page:** https://pz-mod-stats.vercel.app/

## How it works

Steam's Workshop API sends no CORS headers, so a browser can't call it directly
from another origin. Everything below follows from that one fact — it's why the
recorded history is gathered in CI, and why live numbers need a same-origin
function rather than a direct call.

History is recorded on a cron:

```
cron (5 min) ──▶ scripts/fetch.mjs ──▶ data/history.json ──▶ force-push
                                              ▲                    │
                                              └── stats-data branch ◀┘
                                                        │
                index.html polls it every 60s via raw.  ◀┘
```

`data/history.json` accumulates a sample every time a number moves, so the page
shows growth over time — something the Workshop itself never gives you. It holds
two records per mod:

| Key | Shape | Holds |
|---|---|---|
| `series[id]` | `[[t, subs, favs, views, lifeSubs, lifeFavs, up, down], …]` | one row per sample, in `fields` order |
| `events[id]` | `[t, …]` | Steam's `time_updated` each time the mod is edited |

`events` is a list of its own rather than a ninth row field because samples
older than 45 days are thinned to one per UTC day, which can delete the very row
that witnessed an edit — and only in old history, where nobody would notice. The
list is immune to that, and seeds itself from the `time_updated` already stored
in `mods[id].updated`, so it starts with one true annotation per mod. Recording
an event counts as a change: an edit that moves no counters must still reach the
force-push, or the event is lost.

**That file is not in the site, and not on `master`.** It lives alone on the
`stats-data` orphan branch, which the poller rebuilds as a parentless commit and
force-pushes each run. So it is always exactly one commit deep no matter how
many years of samples it holds, and 288 polls a day add nothing to `master`'s
history. The page reads it cross-origin from `raw.githubusercontent.com`, which
sends `access-control-allow-origin: *`, using the `DATA_REPO` constant at the
top of `index.html`'s script.

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
sources.

Charts splice it in too, at `rowsLive()`: the live reading is appended as a
virtual final sample whenever it's newer than the last recorded one, so a line
ends exactly where the number above it says it does. Baselines deliberately
don't — `baseline()` reads `rowsFor()`, recorded history only, because a window
comparison has to anchor to a sample that will still be there after a reload.

If the function isn't there — a static host with no serverless runtime, or a
local `index.html` opened straight off disk — the page notices the first 404 and
silently falls back to history-only. Nothing breaks.

`Cache-Control: s-maxage=30` means Vercel's edge answers most requests without
invoking the function, so a hundred open tabs still cost Steam one call per 30
seconds. That's what keeps this inside the free tier; don't remove it.

**Deploying:** point Vercel at this repo. It serves `index.html` statically and
picks up `/api` automatically — no `package.json`, no build step, no config.
Set `STEAM_API_KEY` in the project's environment variables if you want live star
ratings; without it, `up`/`down` come back null exactly as they do in CI.

`DATA_REPO` is hardcoded rather than derived from the hostname: served from
Vercel there's no `github.io` name to read it from. Change it if you fork or
rename the repo, or the charts will quietly load nothing.

Two Steam endpoints are involved:

| Endpoint | Key? | Gives |
|---|---|---|
| `ISteamRemoteStorage/GetPublishedFileDetails` | no | subscriptions, favourites, views, lifetime counters |
| `IPublishedFileService/GetDetails` | **yes** | vote data (the star rating) |

Without `STEAM_API_KEY` set, everything but the rating still records.

## Setup

1. **Create a public repo** named `pz-mod-stats` and push this directory to it.
   Public matters for two reasons: Actions minutes are free on public repos, and
   the page reads `history.json` anonymously from `raw.githubusercontent.com`,
   which only works on a public repo.

2. **Kick off the poller** — Actions → *Poll workshop stats* → Run workflow. The
   first run creates the `stats-data` branch; until it exists the page has no
   history to draw. After that the cron takes over.

3. **Deploy to Vercel** — point a new project at the repo. It serves
   `index.html` statically and picks up `/api` automatically: no framework
   preset, no build command, no config file. This is what makes the live numbers
   work, since the function has to share an origin with the page.

4. **Add the rating key** (optional) — grab one at
   <https://steamcommunity.com/dev/apikey> (domain can be anything). It goes in
   **two places**, because two things call the keyed endpoint: repo Settings →
   Secrets and variables → Actions → `STEAM_API_KEY` for the poller, and the
   Vercel project's environment variables for the live function. Setting only
   one gives you ratings in only half the page.

The page works on a phone; "Add to Home Screen" gives it an icon and opens it
without browser chrome.

## Adding a mod

Append to `mods.json` with the next free `slot`:

```json
{ "id": "1234567890", "short": "Display Name", "slot": 8 }
```

`slot` fixes the chart colour to the mod, so reordering or removing entries
never repaints the others. Slots map to the categorical palette in
`index.html` (`--s1`…`--s7`, declared once per theme block and listed in
`SLOT_VAR`); add a `--s8` token in all three blocks if you go past seven.

`mods.json` is the only place to edit — both `scripts/fetch.mjs` and
`api/stats.js` read their IDs from it, so the poller and the live endpoint can't
drift apart. Vercel redeploys on push, so the new mod appears in both.

## Notes

- A single mod can be opened on its own — click a card, or the chevron on it.
  The page scopes to that mod rather than opening a panel: the hero, the tiles
  and the table all follow, and every chart mode keeps working (Stacked steps
  aside, since a stack of one band is just the line). The scope lives in the
  hash as `#mod=<id>`, so a focused view is linkable and survives a reload.
- Scheduled workflows are disabled after 60 days of repository inactivity. The
  poller's own pushes to `stats-data` should count, but if it ever goes quiet,
  push anything and re-enable the workflow in the Actions tab.
- The poll runs every 5 minutes, which is GitHub's documented floor for
  `schedule:` — and runs are queued best-effort on top of that, so it's a floor,
  not a promise. Going below it means polling from outside Actions.
- Old samples are thinned to one per day after 45 days to keep the file small.
- `python tools/make_icons.py` regenerates the home-screen icons.
