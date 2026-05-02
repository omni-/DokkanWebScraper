import { saveDokkanStatsResults } from './dokkanstatsScraper';

saveDokkanStatsResults().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
