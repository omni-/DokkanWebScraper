# DokkanWebScraper
Character data comes from DokkanStats; Dokkan Info supplies card obtainment and event/stage
metadata. DokkanDB supplies boss skills. The character JSON contract in `character.ts` is retained.
Node 20+ and curl on PATH are required. Install with `npm ci`.

## Character data
The default `npm run run` and explicit `npm run run:dokkanstats` both use DokkanStats.
```
npm run run:dokkanstats
```

Writes the prettified character JSON to `./data/{currentDate}DokkanCharacterData.json` and
downloads any missing card thumbs to `./data/images/thumbs/`.

Before fetching anything it checks how recent the newest release in the index is and aborts if
that is more than 60 days ago. A retired DokkanStats endpoint keeps returning 200 with a frozen
snapshot instead of failing, so without this check the scrape quietly stops picking up new units.
If the game genuinely goes quiet for that long, set `DOKKANSTATS_MAX_INDEX_AGE_DAYS` higher.

### Card + event metadata (Dokkan Info)
Used when adding new content to DokkanDaily: which new units are premium (summon-only, so they
belong in the leader list) and which challenge events are permanent (so they can become stages).

```
# Is each of these cards summon-only or F2P?
npm run run:dokkaninfo -- cards --ids 1033821,1034221

# Every challenge event, with stage counts and whether it will go away
npm run run:dokkaninfo -- events --permanent-only --out data/challengeEvents.json

# banner.png + wall.png for one event, sized exactly as DokkanDaily expects
npm run run:dokkaninfo -- event-images --id 1766 --out ../DokkanDaily/src/DokkanDaily/wwwroot/images/events/SMB_RE_DAIMA

# Enemy skills for every stage of one event, for deciding how hard it is
npm run run:dokkaninfo -- bosses --id 1766 --out data/bosses.json
```

dokkaninfo.com sits behind CloudFlare, which blocks Node's TLS fingerprint no matter what headers
you send, so these commands shell out to `curl`.

`bosses` is the odd one out: dokkaninfo knows which stages an event has but nothing about the
enemies in them, so it takes the stage ids from there and everything else from DokkanDB's API. It
drops the four skills every Red Zone / Supreme Magnificent Battle boss shares (reduces damage
received, stun immunity, disables ATK & DEF reduction, nullifies Super Attack sealing) since they
say nothing about difficulty - pass `--all-skills` to keep them. Per-phase HP/ATK/DEF and super
attack damage are not available from the API at all; each stage carries a `url` to the DokkanDB
page that renders them.

## Structured stage export

```bash
npm run run:dokkaninfo -- stage-metadata --out <scratch>/stage-metadata.json
# Optional explicit selection (unknown IDs fail):
npm run run:dokkaninfo -- stage-metadata --ids 701,1769 --out <scratch>/selected.json
# From DokkanDaily:
python scripts/sync-stage-links.py --metadata <scratch>/stage-metadata.json --dry-run
```

The export is `{ "schemaVersion": 1, "events": [...] }`. Each event contains `id`, `title`,
`sourceUrl`, and `stages`. Each stage contains its visible `number`, decoded `title`, and
`destinations: [{ "id": 7010075, "url": "https://dokkaninfo.com/events/challenge/701/7010075" }]`.
Numbers may have gaps. Every unique difficulty destination is retained; unrelated hosts/events
are excluded. Missing headings, destinations, conflicting titles, unknown selections and fetch
failures abort the entire export before replacing the output. Without `--ids`, all challenge
events are required. Export files belong in an external scratch directory.

Daily owns active catalog matching, overrides, difficulty link selection, links and OCR alias
catalogs. Its character importer and `dokkan_calc.py` also stay in Daily. `bosses` uses the same
stage mapping and requests every difficulty ID, retaining its visible level and title.

## Build and validation

```bash
npm run build
npm test
```

Tests are offline and do not run a character scrape. `lib/` is untracked generated output;
each build deletes it before compiling sources and declarations. The package entry point is
a side-effect-free library exporting character types and supported adapters. Legacy Fandom
APIs are removed; `npm run run` now uses DokkanStats. CI validates builds/tests and does not
publish to npm. No existing npm release is changed by this repository cleanup.
