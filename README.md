# DokkanWebScraper
Scrapes the Dokkan Wiki to build a database of characters etc

## NEW METHOD
Fandom wiki added CloudFlare protection, bricking the old scraper. It's updated to get around CloudFlare, but spawns a ton of headless Edge instances to do it. Yucky.
Run the new scraper with the following command to instead invoke the DokkanStats api for json and scrape them for image thumbnails which are then downloaded. 
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
```

dokkaninfo.com sits behind CloudFlare, which blocks Node's TLS fingerprint no matter what headers
you send, so these commands shell out to `curl`.

## OLD METHOD
### Run locally
```
npm run run
```

Output goes to `./data/{currentDate}DokkanCharacterData.json`

### Test 
```
npm run test
```
