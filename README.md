# Murder on Zidane's Floor — Squad Room

The SKLW FPL team page for all 16 managers: table, next-GW lineups with expected points, the lineup vote,
squads, head-to-heads and ownership.

**Site:** https://zidanes-floor.github.io/vote/

## How it works

| Part | Where it lives | Updates |
|---|---|---|
| Page | `site/index.html` (+ `site/backend.js`, `site/config.js`) | when this repo changes |
| FPL data (squads, points, fixtures, prices) | `site/data/fpl.json`, built by `scripts/sync.mjs` + `scripts/build.py` | automatically every hour (GitHub Actions), or *Actions → Sync FPL data and publish → Run workflow* |
| Solio expected points | a scheduled Claude task reads Solio's Projections table in the club admin's signed-in browser (`tools/solio-reader.js`) and sends it to the Sheet; the sync matches it to FPL players into `raw/xp_solio.json` | every 3 hours while that computer is on (Claude scheduled task), published within the hour; FPL's own estimate fills in for any gameweek Solio doesn't cover |
| Saved lineups, member-list changes, votes | the club Google Sheet (`apps-script/Code.gs`, deployed as a web app) | live |
| Screenshot reading | the same web app, calling Google's Gemini API (free tier) with the key stored in the Sheet's script properties | live, capped per day |

Anyone with the link can view, save lineups, vote, upload screenshots and change the member list.

## Members

`raw/club.json` lists the FPL IDs, Twitter handles and roles in display order. IDs added on the site's
**FPL IDs** screen are picked up by the next automatic sync.

## Changing the backend

Put the web app URL (ends in `/exec`) in `site/config.js`. To change the Gemini key (`GEMINI_API_KEY`), the model
(`GEMINI_MODEL`) or the daily screenshot limit (`READ_LIMIT`, default 100), edit the script properties in the Sheet's
Apps Script project — no redeploy needed. After editing `Code.gs`, use *Deploy → Manage deployments → Edit → New version* so the URL stays the same.
