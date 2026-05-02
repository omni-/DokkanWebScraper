"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const dokkanstatsScraper_1 = require("./dokkanstatsScraper");
(0, dokkanstatsScraper_1.saveDokkanStatsResults)().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
//# sourceMappingURL=dokkanstats.js.map