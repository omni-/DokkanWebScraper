import axios, { AxiosError } from 'axios';
import { JSDOM } from 'jsdom';
import { Character, Rarities, Classes, Types, Transformation } from "./character";

const BASE_URL = 'https://dbz-dokkanbattle.fandom.com';
const CATEGORY_URL = `${BASE_URL}/wiki/Category:`;
const MAX_BROWSER_CONCURRENCY = 4;
const BROWSER_WAIT_TIMEOUT_MS = parseInt(process.env.DOKKAN_BROWSER_TIMEOUT_MS ?? '60000', 10);
const CHALLENGE_POLL_INTERVAL_MS = 1000;
const VERBOSE_LOGGING = process.env.DOKKAN_VERBOSE === '1';
const BROWSER_HEADERS = {
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
};

interface BrowserStrategy {
    channel?: string;
    description: string;
    headless: boolean;
}

interface BrowserFetcher {
    browser: any;
    context: any;
    strategy: BrowserStrategy;
}

let browserFetcherPromise: Promise<BrowserFetcher> | undefined;
let activeBrowserStrategyIndex = 0;

function logVerbose(message: string) {
    if (VERBOSE_LOGGING) {
        console.log(`[dokkan] ${message}`);
    }
}

export async function getDokkanData(rarity: string) {
    const document: Document = await fetchFromWeb(`${CATEGORY_URL}${rarity}`);
    const links: string[] = extractLinks(document);
    logVerbose(`Found ${links.length} links for ${rarity}`);

    const charactersData = await mapWithConcurrency(links, MAX_BROWSER_CONCURRENCY, async (link, index) => {
        logVerbose(`Fetching ${rarity} character ${index + 1}/${links.length}: ${link}`);
        const characterDocument: Document = await fetchFromWeb(link);
        logVerbose(`Parsed ${rarity} character ${index + 1}/${links.length}: ${link}`);
        return extractCharacterData(characterDocument);
    });

    return charactersData.filter((character): character is Character => character != null);
}

async function mapWithConcurrency<T, TResult>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<TResult>,
) {
    const results = new Array<TResult>(items.length);
    let nextIndex = 0;

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (nextIndex < items.length) {
            const currentIndex = nextIndex++;
            results[currentIndex] = await mapper(items[currentIndex], currentIndex);
        }
    });

    await Promise.all(workers);
    return results;
}

async function fetchPage(url: string): Promise<string> {
    logVerbose(`HTTP fetch: ${url}`);
    try {
        const response = await axios.get(url, {
            headers: BROWSER_HEADERS,
        });

        if (isCloudflareChallengePage(response.data)) {
            logVerbose(`Cloudflare challenge detected after HTTP fetch: ${url}`);
            return fetchPageWithBrowser(url);
        }

        return response.data;
    } catch (error) {
        if (shouldUseBrowserFallback(error)) {
            logVerbose(`HTTP fetch blocked, switching to browser fallback: ${url}`);
            return fetchPageWithBrowser(url);
        }

        throw error;
    }
}

function shouldUseBrowserFallback(error: unknown) {
    if (!axios.isAxiosError(error)) {
        return false;
    }

    return error.response?.status === 403
        || error.response?.headers?.['cf-mitigated'] === 'challenge'
        || isCloudflareChallengePage(typeof error.response?.data === 'string' ? error.response.data : undefined);
}

function isCloudflareChallengePage(html?: string) {
    return typeof html === 'string'
        && (html.includes('<title>Just a moment...</title>')
            || html.includes('cf-mitigated')
            || html.includes('Enable JavaScript and cookies to continue'));
}

async function fetchPageWithBrowser(url: string) {
    let lastError: unknown;

    for (let strategyIndex = activeBrowserStrategyIndex; strategyIndex < getBrowserStrategies().length; strategyIndex++) {
        let browserFetcher: BrowserFetcher;
        try {
            browserFetcher = await getBrowserFetcher(strategyIndex);
        } catch (error) {
            lastError = error;
            logVerbose(`Browser strategy setup failed for ${getBrowserStrategies()[strategyIndex]?.description ?? 'unknown strategy'}: ${error instanceof Error ? error.message : String(error)}`);
            await resetBrowserFetcher();
            continue;
        }

        const page = await browserFetcher.context.newPage();

        try {
            logVerbose(`Browser fetch with ${browserFetcher.strategy.description}: ${url}`);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_WAIT_TIMEOUT_MS });
            await waitForRealContent(page, browserFetcher.strategy.description);
            activeBrowserStrategyIndex = strategyIndex;
            logVerbose(`Browser fetch succeeded with ${browserFetcher.strategy.description}: ${url}`);
            return await page.content();
        } catch (error) {
            lastError = error;
            logVerbose(`Browser fetch failed with ${browserFetcher.strategy.description}: ${url} (${error instanceof Error ? error.message : String(error)})`);
            await resetBrowserFetcher();
        } finally {
            await page.close();
        }
    }

    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    const headedHint = process.env.DOKKAN_ALLOW_HEADED_BROWSER === '1'
        ? ''
        : ' Set DOKKAN_ALLOW_HEADED_BROWSER=1 to let Playwright retry with a visible browser window.';

    throw new Error(`Browser fallback failed for ${url}. ${reason}.${headedHint}`);
}

async function waitForRealContent(page: any, strategyDescription: string) {
    const deadline = Date.now() + BROWSER_WAIT_TIMEOUT_MS;
    let lastStatusLog = 0;

    while (Date.now() < deadline) {
        await page.waitForTimeout(CHALLENGE_POLL_INTERVAL_MS);
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);

        const state = await page.evaluate(() => ({
            hasParserOutput: Boolean(document.querySelector('.mw-parser-output')),
            hasChallengeText: document.body?.textContent?.includes('Enable JavaScript and cookies to continue') ?? false,
            title: document.title,
        }));

        if (state.hasParserOutput && state.title !== 'Just a moment...' && !state.hasChallengeText) {
            return;
        }

        if (VERBOSE_LOGGING && Date.now() - lastStatusLog >= 5000) {
            lastStatusLog = Date.now();
            logVerbose(`Waiting for page content via ${strategyDescription}; title="${state.title}", parser=${state.hasParserOutput}, challengeText=${state.hasChallengeText}`);
        }
    }

    const finalTitle = await page.title().catch(() => 'Unknown title');
    throw new Error(`Timed out waiting for Cloudflare to clear using ${strategyDescription}. Last page title: ${finalTitle}`);
}

function getBrowserStrategies(): BrowserStrategy[] {
    const strategies: BrowserStrategy[] = [
        { channel: 'msedge', headless: true, description: 'Edge headless' },
        { channel: 'chrome', headless: true, description: 'Chrome headless' },
        { headless: true, description: 'Chromium headless' },
    ];

    if (process.env.DOKKAN_ALLOW_HEADED_BROWSER === '1') {
        strategies.push(
            { channel: 'msedge', headless: false, description: 'Edge headed' },
            { channel: 'chrome', headless: false, description: 'Chrome headed' },
            { headless: false, description: 'Chromium headed' },
        );
    }

    return strategies;
}

async function getBrowserFetcher(strategyIndex = activeBrowserStrategyIndex) {
    if (!browserFetcherPromise) {
        browserFetcherPromise = createBrowserFetcher(strategyIndex).catch(error => {
            browserFetcherPromise = undefined;
            throw error;
        });
    }

    return browserFetcherPromise;
}

async function resetBrowserFetcher() {
    await closeBrowserFetcher();
}

export async function closeBrowserFetcher() {
    if (!browserFetcherPromise) {
        return;
    }

    try {
        const { browser } = await browserFetcherPromise;
        await browser.close();
    } finally {
        browserFetcherPromise = undefined;
    }
}

async function createBrowserFetcher(strategyIndex: number): Promise<BrowserFetcher> {
    let playwright: any;

    try {
        playwright = require('playwright');
    } catch (error) {
        throw new Error('Cloudflare blocked the HTTP request and Playwright is not available for the browser fallback.');
    }

    const strategy = getBrowserStrategies()[strategyIndex];
    if (!strategy) {
        throw new Error('No Playwright browser strategies are available.');
    }

    try {
        logVerbose(`Launching browser strategy: ${strategy.description}`);
        const browser = await playwright.chromium.launch({
            channel: strategy.channel,
            headless: strategy.headless,
            args: ['--disable-blink-features=AutomationControlled'],
        });
        const context = await browser.newContext({
            extraHTTPHeaders: BROWSER_HEADERS,
            hasTouch: false,
            isMobile: false,
            locale: 'en-US',
            screen: { width: 1365, height: 945 },
            userAgent: BROWSER_HEADERS['User-Agent'],
            viewport: { width: 1365, height: 945 },
        });

        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
        });

        return { browser, context, strategy };
    } catch (error) {
        logVerbose(`Failed to launch browser strategy ${strategy.description}: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}

export async function fetchFromWeb(url: string) {
    const HTMLData = await fetchPage(url);
    const dom = new JSDOM(HTMLData, { url });
    return dom.window.document;
}

function extractLinks(document: Document) {
    const URIs: HTMLAnchorElement[] = Array.from(
        document.querySelectorAll('.category-page__member-link'),
    );

    return Array.from(new Set(URIs.map(link => link.href)));
}

function isValidHttpUrl(value?: string | null) {
    if (!value) {
        return false;
    }

    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch (_) {
        return false;
    }
}

function extractCardImageUrl(root?: ParentNode | null) {
    if (!root) {
        return undefined;
    }

    const candidates: string[] = [];
    for (const element of Array.from(root.querySelectorAll('a[href], img[src], img[data-src]'))) {
        for (const attribute of ['href', 'data-src', 'src']) {
            const value = element.getAttribute(attribute);
            if (!value || !isValidHttpUrl(value) || !/Card_\d+.*thumb/i.test(value)) {
                continue;
            }

            if (value.includes('sp_phrase')) {
                continue;
            }

            candidates.push(value);
        }
    }

    const preferredCandidates = candidates.filter(value => !value.includes('/wiki/File:'));

    return preferredCandidates.find(value => value.includes('/revision/latest?'))
        ?? preferredCandidates.find(value => value.includes('/revision/latest'))
        ?? preferredCandidates[0]
        ?? candidates[0];
}

function extractClassAndType(root?: ParentNode | null) {
    const title = Array.from(root?.querySelectorAll('a[title]') ?? [])
        .map(link => link.getAttribute('title') ?? '')
        .find(value => value.includes('Category:Super') || value.includes('Category:Extreme'));

    const classMatch = title?.match(/Category:(Super|Extreme)/);
    const typeMatch = title?.match(/\b(AGL|TEQ|INT|STR|PHY)\b/);

    return {
        class: classMatch ? Classes[classMatch[1] as keyof typeof Classes] : undefined,
        type: typeMatch ? Types[typeMatch[1] as keyof typeof Types] : undefined,
    };
}

function extractKiMultiplier(characterDocument: Document) {
    const primary = characterDocument.querySelector('.righttablecard > table:nth-child(6) > tbody:nth-child(1) > tr:nth-child(2) > td:nth-child(1)')?.innerHTML;
    if (primary) {
        const firstEntry = primary.split('â–º ')[1]?.split('<br>')[0];
        const secondEntry = primary.split('<br>â–º ')[1];
        if (firstEntry) {
            return firstEntry
                .concat(secondEntry ? `; ${secondEntry}` : '')
                .replace('<a href="/wiki/Super_Attack_Multipliers" title="Super Attack Multipliers">SA Multiplier</a>', 'SA Multiplier');
        }
    }

    return characterDocument.querySelector('.righttablecard')?.nextElementSibling?.querySelector('tr:nth-child(2) > td')?.textContent?.split('â–º ')[1] ?? 'Error';
}

export function extractCharacterData(characterDocument: Document) {
    const parserOutput = characterDocument.querySelector('.mw-parser-output');
    const awakenArrow = parserOutput?.querySelector('img[alt="Arrow"]');
    if (awakenArrow != null) {
        return null;
    }

    const transformedCharacterData: Transformation[] = extractTransformedCharacterData(characterDocument);
    const baseTable = parserOutput?.querySelector('table');
    const titleNameCell = baseTable?.querySelector('tbody > tr > td:nth-child(2)');
    const classAndType = extractClassAndType(baseTable?.querySelector('tbody > tr:nth-child(3) > td:nth-child(4)'));

    const characterData: Character = {
        name: titleNameCell?.innerHTML.split('<br>')[1].split('</b>')[0].replaceAll('&amp;', '&') ?? 'Error',
        title: titleNameCell?.innerHTML.split('<br>')[0].split('<b>')[1] ?? 'Error',
        maxLevel: parseInt((baseTable?.querySelector('tbody > tr:nth-child(3) > td')?.textContent?.split('/')[1] || baseTable?.querySelector('tbody > tr:nth-child(3) > td')?.textContent?.split('/')[0]) ?? 'Error'),
        maxSALevel: parseInt((baseTable?.querySelector('tbody > tr:nth-child(3) > td:nth-child(2) > center')?.innerHTML.split('>/')[1]) ?? 'Error'),
        rarity: Rarities[baseTable?.querySelector('tbody > tr:nth-child(3) > td:nth-child(3) > center a')?.getAttribute('title')?.split('Category:')[1] ?? 'Error'],
        class: classAndType.class ?? Classes[baseTable?.querySelector('tbody > tr:nth-child(3) > td:nth-child(4) > center:nth-child(1) > span > a:nth-child(1)')?.getAttribute('title')?.split(' ')[0].split('Category:')[1] ?? 'Error'],
        type: classAndType.type ?? Types[baseTable?.querySelector('tbody > tr:nth-child(3) > td:nth-child(4) > center:nth-child(1) > span > a:nth-child(1)')?.getAttribute('title')?.split(' ')[1] ?? 'Error'],
        cost: parseInt((baseTable?.querySelector('tbody > tr:nth-child(3) > td:nth-child(5) > center:nth-child(1)')?.textContent) ?? 'Error'),
        id: baseTable?.querySelector('tbody > tr:nth-child(3) > td:nth-child(6) > center:nth-child(1)')?.textContent ?? 'Error',
        imageURL: extractCardImageUrl(baseTable) ?? 'Error',
        leaderSkill: characterDocument.querySelector('[data-image-name="Leader Skill.png"]')?.closest('tr')?.nextElementSibling?.textContent ?? 'Error',
        ezaLeaderSkill: characterDocument.querySelector('.ezatabber > div > div:nth-child(3) > table > tbody > tr:nth-child(2) > td')?.textContent ?? undefined,
        superAttack: characterDocument.querySelector('[data-image-name="Super atk.png"]')?.closest('tr')?.nextElementSibling?.textContent ?? 'Error',
        ezaSuperAttack: characterDocument.querySelectorAll('table.ezawidth')[1]?.querySelector('[data-image-name="Super atk.png"]')?.closest('tr')?.nextElementSibling?.textContent ?? undefined,
        ultraSuperAttack: characterDocument.querySelector('[data-image-name="Ultra Super atk.png"]')?.closest('tr')?.nextElementSibling?.textContent ?? undefined,
        ezaUltraSuperAttack: characterDocument.querySelectorAll('table.ezawidth')[1]?.querySelector('[data-image-name="Ultra Super atk.png"]')?.closest('tr')?.nextElementSibling?.textContent ?? undefined,
        passive: characterDocument.querySelector('[data-image-name="Passive skill.png"]')?.closest('tr')?.nextElementSibling?.textContent ?? 'Error',
        ezaPassive: (characterDocument.querySelectorAll('table.ezawidth')[1]?.querySelector('[data-image-name="Passive skill.png"]')?.closest('tr')?.nextElementSibling?.textContent || characterDocument.querySelectorAll('table.ezawidth')[1]?.querySelector('center:nth-child(2)')?.textContent) ?? undefined,
        superEzaPassive: characterDocument.querySelectorAll('table.ezawidth')[1]?.querySelector('center:nth-child(2)')?.parentElement?.nextElementSibling?.textContent ?? undefined,
        activeSkill: (characterDocument.querySelector('[data-image-name="Active skill.png"]')?.closest('tr')?.nextElementSibling?.textContent || characterDocument.querySelector('[data-image-name="Active skill.png"]')?.closest('tr')?.nextElementSibling?.nextElementSibling?.textContent) ?? undefined,
        activeSkillCondition: characterDocument.querySelector('[data-image-name="Active skill.png"]')?.closest('tr')?.nextElementSibling?.nextElementSibling?.nextElementSibling?.querySelector('td > center')?.textContent ?? undefined,
        ezaActiveSkill: characterDocument.querySelectorAll('table.ezawidth')[1]?.querySelector('[data-image-name="Active skill.png"]')?.closest('tr')?.nextElementSibling?.textContent ?? undefined,
        ezaActiveSkillCondition: characterDocument.querySelectorAll('table.ezawidth')[1]?.querySelector('[data-image-name="Active skill.png"]')?.closest('tr')?.nextElementSibling?.nextElementSibling?.nextElementSibling?.querySelector('td > center')?.textContent ?? undefined,
        transformationCondition: characterDocument.querySelector('[data-image-name="Transformation Condition.png"]')?.closest('tr')?.nextElementSibling?.querySelector('td > center')?.textContent ?? undefined,
        links: Array.from(characterDocument.querySelector('[data-image-name="Link skill.png"]')?.closest('tr')?.nextElementSibling?.querySelectorAll('span > a') ?? []).map(link => link.textContent ?? 'Error'),
        categories: Array.from(characterDocument.querySelector('[data-image-name="Category.png"]')?.closest('tr')?.nextElementSibling?.querySelectorAll('a') ?? []).map(link => link.textContent ?? 'Error'),
        baseHP: parseInt(characterDocument.querySelector('.righttablecard > table:nth-child(3) > tbody:nth-child(1) > tr:nth-child(2) > td:nth-child(2) > center:nth-child(1)')?.textContent ?? 'Error'),
        maxLevelHP: parseInt(characterDocument.querySelector('.righttablecard > table:nth-child(3) > tbody:nth-child(1) > tr:nth-child(2) > td:nth-child(3) > center:nth-child(1)')?.textContent ?? 'Error'),
        freeDupeHP: parseInt(characterDocument.querySelector('.righttablecard > table:nth-child(3) > tbody:nth-child(1) > tr:nth-child(2) > td:nth-child(4) > center:nth-child(1)')?.textContent ?? 'Error'),
        rainbowHP: parseInt(characterDocument.querySelector('.righttablecard > table:nth-child(3) > tbody:nth-child(1) > tr:nth-child(2) > td:nth-child(5) > center:nth-child(1)')?.textContent ?? 'Error'),
        baseAttack: parseInt(characterDocument.querySelector('.righttablecard > table:nth-child(3) > tbody:nth-child(1) > tr:nth-child(3) > td:nth-child(2) > center:nth-child(1)')?.textContent ?? 'Error'),
        maxLevelAttack: parseInt(characterDocument.querySelector('.righttablecard > table:nth-child(3) > tbody:nth-child(1) > tr:nth-child(3) > td:nth-child(3) > center:nth-child(1)')?.textContent ?? 'Error'),
        freeDupeAttack: parseInt(characterDocument.querySelector('.righttablecard > table:nth-child(3) > tbody:nth-child(1) > tr:nth-child(3) > td:nth-child(4) > center:nth-child(1)')?.textContent ?? 'Error'),
        rainbowAttack: parseInt(characterDocument.querySelector('.righttablecard > table:nth-child(3) > tbody:nth-child(1) > tr:nth-child(3) > td:nth-child(5) > center:nth-child(1)')?.textContent ?? 'Error'),
        baseDefence: parseInt(characterDocument.querySelector('.righttablecard > table:nth-child(3) > tbody:nth-child(1) > tr:nth-child(4) > td:nth-child(2) > center:nth-child(1)')?.textContent ?? 'Error'),
        maxDefence: parseInt(characterDocument.querySelector('.righttablecard > table:nth-child(3) > tbody:nth-child(1) > tr:nth-child(4) > td:nth-child(3) > center:nth-child(1)')?.textContent ?? 'Error'),
        freeDupeDefence: parseInt(characterDocument.querySelector('.righttablecard > table:nth-child(3) > tbody:nth-child(1) > tr:nth-child(4) > td:nth-child(4) > center:nth-child(1)')?.textContent ?? 'Error'),
        rainbowDefence: parseInt(characterDocument.querySelector('.righttablecard > table:nth-child(3) > tbody:nth-child(1) > tr:nth-child(4) > td:nth-child(5) > center:nth-child(1)')?.textContent ?? 'Error'),
        kiMultiplier: extractKiMultiplier(characterDocument),
        transformations: transformedCharacterData,
    };

    return characterData;
}

function extractTransformedCharacterData(characterDocument: Document): Transformation[] {
    const transformedArray: Transformation[] = [];
    const transformCount = characterDocument.querySelectorAll('.mw-parser-output > div:nth-child(2) > div > ul > li').length;

    for (let index = 1; index < transformCount; index++) {
        const transformationRoot = characterDocument.querySelector(`.mw-parser-output > div:nth-child(2) > div:nth-child(${index + 2})`);
        const transformationTable = transformationRoot?.querySelector('table');
        const classAndType = extractClassAndType(transformationTable?.querySelector('tbody > tr:nth-child(3) > td:nth-child(4)'));

        const transformationData: Transformation = {
            transformedName: transformationTable?.querySelector('tbody > tr > td:nth-child(2)')?.innerHTML.split('<br>')[1].split('</b>')[0].replaceAll('&amp;', '&') ?? 'Error',
            transformedID: transformationTable?.querySelector('tbody > tr:nth-child(3) > td:nth-child(6)')?.textContent ?? 'Error',
            transformedClass: classAndType.class ?? Classes[transformationTable?.querySelector('tbody > tr:nth-child(3) > td:nth-child(4) > center > a')?.getAttribute('title')?.split(' ')[0].split('Category:')[1] ?? 'Error'],
            transformedType: classAndType.type ?? Types[transformationTable?.querySelector('tbody > tr:nth-child(3) > td:nth-child(4) > center > a')?.getAttribute('title')?.split(' ')[1] ?? 'Error'],
            transformedSuperAttack: transformationRoot?.querySelector('[data-image-name="Super atk.png"]')?.closest('tr')?.nextElementSibling?.textContent ?? 'Error',
            transformedEZASuperAttack: transformationRoot?.querySelector('.righttablecard > table > tbody > tr > td > div > div > div:nth-child(3)')?.querySelector('[data-image-name="Super atk.png"]')?.closest('tr')?.nextElementSibling?.textContent ?? undefined,
            transformedUltraSuperAttack: transformationRoot?.querySelector('[data-image-name="Ultra Super atk.png"]')?.closest('tr')?.nextElementSibling?.textContent ?? undefined,
            transformedEZAUltraSuperAttack: transformationRoot?.querySelector('.righttablecard > table > tbody > tr > td > div > div > div:nth-child(3)')?.querySelector('[data-image-name="Ultra Super atk.png"]')?.closest('tr')?.nextElementSibling?.textContent ?? undefined,
            transformedPassive: transformationRoot?.querySelector('[data-image-name="Passive skill.png"]')?.closest('tr')?.nextElementSibling?.textContent ?? 'Error',
            transformedEZAPassive: transformationRoot?.querySelector('.righttablecard > table > tbody > tr > td > div > div > div:nth-child(3)')?.querySelector('[data-image-name="Passive skill.png"]')?.closest('tr')?.nextElementSibling?.textContent ?? undefined,
            transformedActiveSkill: transformationRoot?.querySelector('[data-image-name="Active skill.png"]')?.closest('tr')?.nextElementSibling?.textContent ?? undefined,
            transformedActiveSkillCondition: transformationRoot?.querySelector('[data-image-name="Activation Condition.png"]')?.closest('tr')?.nextElementSibling?.textContent ?? undefined,
            transformedLinks: Array.from(transformationRoot?.querySelector('[data-image-name="Link skill.png"]')?.closest('tr')?.nextElementSibling?.querySelectorAll('span > a') ?? []).map(link => link.textContent ?? 'Error'),
            transformedImageURL: extractCardImageUrl(transformationTable ?? transformationRoot) ?? 'Error',
        };

        transformedArray.push(transformationData);
    }

    return transformedArray;
}

export async function getURCharacterPages() {
    let document: Document = await fetchFromWeb(`${CATEGORY_URL}UR`);
    const ret: string[] = ['UR'];

    while (true) {
        const button = Array.from(document.querySelectorAll('.category-page__pagination a.wds-button')).find(x => x.innerHTML.includes('<span>Next</span>'));
        if (button == null) {
            break;
        }

        const nextPage = (button as HTMLAnchorElement).href.split('/wiki/Category:')[1];
        if (!nextPage) {
            break;
        }

        ret.push(nextPage);
        document = await fetchFromWeb(`${CATEGORY_URL}${nextPage}`);
    }

    return ret;
}
