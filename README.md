# Workshop Stats

A self-updating dashboard for my Project Zomboid Workshop mods — subscribers,
favourites, views and ratings, on one page that refreshes itself.

**Live page:** https://nickjgg.github.io/pz-mod-stats/

## How it works

Steam's Workshop API sends no CORS headers, so a browser can't call it directly
from another origin. The fetch therefore happens in CI:

```
cron (15 min) ──▶ scripts/fetch.mjs ──▶ data/history.json ──▶ commit ──▶ Pages
                                                                          │
                          index.html polls data/history.json every 60s ◀──┘
```

`data/history.json` accumulates a sample every time a number moves, so the page
shows growth over time — something the Workshop itself never gives you.

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
   branch `master`, folder `/ (root)`.

3. **Add the rating key** (optional) — grab one at
   <https://steamcommunity.com/dev/apikey> (domain can be anything), then
   Settings → Secrets and variables → Actions → New repository secret,
   named `STEAM_API_KEY`.

4. **Kick it off** — Actions → *Poll workshop stats* → Run workflow. After that
   the cron takes over.

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
  poller's own commits normally count, but if it ever goes quiet, push anything
  and re-enable the workflow in the Actions tab.
- Cron runs are best-effort — GitHub queues them, so "every 15 minutes" is a
  floor, not a guarantee. Four runs an hour also keeps this under the ~10
  Pages builds/hour soft limit.
- Old samples are thinned to one per day after 45 days to keep the file small.
- `python tools/make_icons.py` regenerates the home-screen icons.
