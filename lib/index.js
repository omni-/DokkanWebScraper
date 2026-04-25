"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveDokkanResults = void 0;
const fs_1 = require("fs");
const promises_1 = require("fs/promises");
const path_1 = require("path");
const scraper_1 = require("./scraper");
async function saveDokkanResults() {
    try {
        console.log('Starting scrape');
        const sections = await (0, scraper_1.getURCharacterPages)();
        let results = [];
        let i = 0;
        for (i = 0; i < sections.length; i++) {
            console.log("Fetching UR page " + (i + 1));
            let data = await (0, scraper_1.getDokkanData)(sections[i]);
            results.push(data);
        }
        console.log("Fetching LRs");
        const LRData = await (0, scraper_1.getDokkanData)('LR');
        console.log('Finished scrape, saving data');
        let data = LRData.concat(results.flat());
        let currentDate = new Date();
        let day = ("0" + currentDate.getUTCDate()).slice(-2);
        let month = ("0" + currentDate.getUTCMonth() + 1).slice(-2);
        let year = currentDate.getUTCFullYear();
        saveData(year + month + day + 'DokkanCharacterData', data);
    }
    finally {
        await (0, scraper_1.closeBrowserFetcher)();
    }
}
exports.saveDokkanResults = saveDokkanResults;
function saveData(fileName, data) {
    if (!(0, fs_1.existsSync)((0, path_1.resolve)(__dirname, 'data'))) {
        (0, fs_1.mkdirSync)('data');
    }
    (0, promises_1.writeFile)((0, path_1.resolve)(__dirname, `data/${fileName}.json`), JSON.stringify(data), { encoding: 'utf8' });
}
saveDokkanResults();
//# sourceMappingURL=index.js.map