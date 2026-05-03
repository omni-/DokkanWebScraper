# DokkanWebScraper
Scrapes the Dokkan Wiki to build a database of characters etc

## NEW METHOD
Fandom wiki added CloudFlare protection, bricking the old scraper. It's updated to get around CloudFlare, but spawns a ton of headless Edge instances to do it. Yucky.
Run the new scraper with the following command to instead invoke the DokkanStats api for json and scrape them for image thumbnails which are then downloaded. 
```
npm run run:dokkanstats
```

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
