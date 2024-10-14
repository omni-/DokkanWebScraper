import { existsSync, mkdirSync } from "fs";
import { writeFile } from "fs/promises";
import { resolve } from "path";
import { getDokkanData, getURCharacterPages } from "./scraper";

export async function saveDokkanResults() {
    console.log('Starting scrape');

    const sections = await getURCharacterPages();
    let results = [];
    let i = 0;
    for (i = 0; i < sections.length; i++) {
        console.log("Fetching UR page " + (i + 1));
        let data = await getDokkanData(sections[i]);
        results.push(data);
    }
    console.log("Fetching LRs");
    const LRData = await getDokkanData('LR');

    console.log('Finished scrape, saving data');
    let data = LRData.concat(results.flat());
    let currentDate = new Date();
    let day = ("0" + currentDate.getUTCDate()).slice(-2);
    let month = ("0" + currentDate.getUTCMonth() + 1).slice(-2);
    let year = currentDate.getUTCFullYear()
    saveData(year + month + day + 'DokkanCharacterData', data)
}

function saveData(fileName: string, data: unknown) {
    if (!existsSync(resolve(__dirname, 'data'))) {
        mkdirSync('data');
    }
    writeFile(
        resolve(__dirname, `data/${fileName}.json`),
        JSON.stringify(data),
        { encoding: 'utf8' })
}

saveDokkanResults()