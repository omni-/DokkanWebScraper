"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveDokkanStatsResults = exports.getDokkanStatsCharacterData = exports.getDokkanStatsData = void 0;
const axios_1 = require("axios");
const fs_1 = require("fs");
const promises_1 = require("fs/promises");
const path_1 = require("path");
const character_1 = require("./character");
const DOKKANSTATS_BASE_URL = 'https://dokkanstats.com';
const DOKKANSTATS_ASSET_BASE_URL = 'https://assets.dokkanstats.com/assets/global/en';
const MAX_CHARACTERS_URL = `${DOKKANSTATS_BASE_URL}/en/maxcharacters.json`;
const CARD_API_URL = `${DOKKANSTATS_BASE_URL}/api/kv/en/cards`;
const DEFAULT_CONCURRENCY = parseInt(process.env.DOKKANSTATS_CONCURRENCY ?? '4', 10);
const MAX_RETRIES = parseInt(process.env.DOKKANSTATS_MAX_RETRIES ?? '5', 10);
const RETRY_BASE_DELAY_MS = parseInt(process.env.DOKKANSTATS_RETRY_BASE_DELAY_MS ?? '1000', 10);
const RETRY_MAX_DELAY_MS = parseInt(process.env.DOKKANSTATS_RETRY_MAX_DELAY_MS ?? '30000', 10);
const FORBIDDEN_RETRY_DELAY_MS = parseInt(process.env.DOKKANSTATS_403_RETRY_DELAY_MS ?? '5000', 10);
const OUTPUT_ROOT = process.cwd();
const THUMB_DIRECTORY = (0, path_1.resolve)(OUTPUT_ROOT, 'data/images/thumbs');
const REQUEST_HEADERS = {
    'Accept': 'application/json,text/plain,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
};
async function getDokkanStatsData() {
    const indexCharacters = await fetchJson(MAX_CHARACTERS_URL);
    const characterIds = indexCharacters
        .filter(isScrapableCharacterSummary)
        .map(character => character.id);
    const characters = await mapWithConcurrency(characterIds, DEFAULT_CONCURRENCY, async (id, index) => {
        console.log(`Fetching DokkanStats character ${index + 1}/${characterIds.length}: ${id}`);
        try {
            const character = await fetchDokkanStatsCharacter(id);
            if (!isFinalAwakeningForm(character)) {
                return null;
            }
            return mapDokkanStatsCharacter(character);
        }
        catch (error) {
            console.warn(`Skipping DokkanStats character ${id}: ${describeError(error)}`);
            return null;
        }
    });
    return characters.filter((character) => character != null);
}
exports.getDokkanStatsData = getDokkanStatsData;
async function getDokkanStatsCharacterData(id) {
    const character = await fetchDokkanStatsCharacter(id);
    if (!isFinalAwakeningForm(character)) {
        return null;
    }
    return mapDokkanStatsCharacter(character);
}
exports.getDokkanStatsCharacterData = getDokkanStatsCharacterData;
async function saveDokkanStatsResults() {
    const data = await getDokkanStatsData();
    const now = new Date();
    const day = String(now.getUTCDate()).padStart(2, '0');
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const year = now.getUTCFullYear();
    await saveData(`${year}${month}${day}DokkanCharacterData`, data);
}
exports.saveDokkanStatsResults = saveDokkanStatsResults;
async function fetchDokkanStatsCharacter(id) {
    return fetchJson(`${CARD_API_URL}/${id}`);
}
async function fetchJson(url) {
    const response = await requestWithRetry(`GET ${url}`, () => axios_1.default.get(url, { headers: REQUEST_HEADERS }));
    return response.data;
}
async function requestWithRetry(label, request) {
    let lastError;
    let attempt = 1;
    while (true) {
        try {
            return await request();
        }
        catch (error) {
            lastError = error;
            const status = getAxiosStatus(error);
            if (status === 403) {
                const delay = getForbiddenRetryDelay();
                console.warn(`${label} was forbidden (403). Waiting ${delay}ms before retrying.`);
                await sleep(delay);
                attempt += 1;
                continue;
            }
            if (attempt > MAX_RETRIES || !shouldRetryRequest(error)) {
                break;
            }
            const delay = getRetryDelay(attempt);
            console.warn(`${label} failed (${describeError(error)}). Retrying in ${delay}ms (${attempt}/${MAX_RETRIES})`);
            await sleep(delay);
            attempt += 1;
        }
    }
    throw lastError;
}
function shouldRetryRequest(error) {
    if (!axios_1.default.isAxiosError(error)) {
        return false;
    }
    const status = error.response?.status;
    return status == null || status === 403 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}
function getRetryDelay(attempt) {
    const exponentialDelay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    const jitter = Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
    return exponentialDelay + jitter;
}
function getForbiddenRetryDelay() {
    const jitter = Math.floor(Math.random() * 1000);
    return FORBIDDEN_RETRY_DELAY_MS + jitter;
}
function getAxiosStatus(error) {
    return axios_1.default.isAxiosError(error) ? error.response?.status : undefined;
}
function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
async function saveData(fileName, data) {
    const dataDirectory = (0, path_1.resolve)(OUTPUT_ROOT, 'data');
    if (!(0, fs_1.existsSync)(dataDirectory)) {
        (0, fs_1.mkdirSync)(dataDirectory, { recursive: true });
    }
    await (0, promises_1.writeFile)((0, path_1.resolve)(dataDirectory, `${fileName}.json`), JSON.stringify(data, null, 2), { encoding: 'utf8' });
}
async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
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
async function mapDokkanStatsCharacter(character) {
    if (!isSupportedRarity(character.rarity)) {
        return null;
    }
    if (!hasScrapableMaxLevel(character)) {
        return null;
    }
    const basePerformance = getPerformance(character, 'base');
    const ezaPerformance = getPerformance(character, 'eza');
    const sezaPerformance = getPerformance(character, 'seza');
    const imageURL = await downloadCharacterThumb(character.id);
    const transformations = await mapTransformations(character);
    const isLR = isLegendaryRare(character);
    return {
        name: cleanName(character.name ?? character.full_name) ?? 'Error',
        title: cleanText(character.dokkan_name) ?? 'Error',
        maxLevel: numberOrNull(character.lv_max),
        maxSALevel: getMaxSuperAttackLevel(character),
        rarity: character_1.Rarities[character.rarity],
        class: character_1.Classes[character.class],
        type: character_1.Types[character.type],
        id: character.id,
        imageURL,
        leaderSkill: describeSkill(basePerformance?.leader_skill),
        ...(character.eza ? {
            ezaLeaderSkill: describeSkill(ezaPerformance?.leader_skill, undefined),
        } : {}),
        superAttack: describeSuperAttack(basePerformance?.super_attack),
        ...(character.eza ? {
            ezaSuperAttack: describeSuperAttack(ezaPerformance?.super_attack, undefined),
        } : {}),
        ...(isLR ? {
            ultraSuperAttack: describeSuperAttack(basePerformance?.ultra_super_attack, undefined),
        } : {}),
        ...(character.eza && isLR ? {
            ezaUltraSuperAttack: describeSuperAttack(ezaPerformance?.ultra_super_attack, undefined),
        } : {}),
        passive: describePassive(basePerformance?.passive_skill),
        ...(character.eza ? {
            ezaPassive: describePassive(ezaPerformance?.passive_skill, undefined),
        } : {}),
        ...(character.seza ? {
            superEzaPassive: describePassive(sezaPerformance?.passive_skill, undefined),
        } : {}),
        activeSkill: describeActiveSkill(basePerformance?.active_skill, 'effect_description'),
        activeSkillCondition: describeActiveSkill(basePerformance?.active_skill, 'condition_description'),
        ...(character.eza ? {
            ezaActiveSkill: describeActiveSkill(ezaPerformance?.active_skill, 'effect_description'),
        } : {}),
        transformationCondition: transformations.length > 0
            ? describeActiveSkill(basePerformance?.active_skill, 'condition_description')
            : undefined,
        links: (character.links ?? []).map(link => link.name),
        categories: (character.categories ?? []).map(category => category.name),
        baseHP: numberOrNull(basePerformance?.stats_base?.hp),
        maxLevelHP: numberOrNull(basePerformance?.stats_max?.hp),
        freeDupeHP: numberOrNull(basePerformance?.stats_55?.hp),
        rainbowHP: numberOrNull(basePerformance?.stats_100?.hp),
        baseAttack: numberOrNull(basePerformance?.stats_base?.atk),
        maxLevelAttack: numberOrNull(basePerformance?.stats_max?.atk),
        freeDupeAttack: numberOrNull(basePerformance?.stats_55?.atk),
        rainbowAttack: numberOrNull(basePerformance?.stats_100?.atk),
        baseDefence: numberOrNull(basePerformance?.stats_base?.def),
        maxDefence: numberOrNull(basePerformance?.stats_max?.def),
        freeDupeDefence: numberOrNull(basePerformance?.stats_55?.def),
        rainbowDefence: numberOrNull(basePerformance?.stats_100?.def),
        kiMultiplier: undefined,
        transformations,
    };
}
async function mapTransformations(character) {
    const transformationIds = getTransformationIds(character);
    return mapWithConcurrency(transformationIds, DEFAULT_CONCURRENCY, async (id) => {
        try {
            const transformedCharacter = await fetchDokkanStatsCharacter(id);
            return mapTransformedCharacter(transformedCharacter);
        }
        catch (error) {
            console.warn(`Skipping DokkanStats transformation ${id} for ${character.id}: ${describeError(error)}`);
            return null;
        }
    }).then(transformations => transformations.filter((transformation) => transformation != null));
}
async function mapTransformedCharacter(character) {
    if (!isSupportedRarity(character.rarity) || !hasScrapableMaxLevel(character)) {
        throw new Error(`Unsupported transformed form ${character.id} (${character.rarity ?? 'unknown'} level ${character.lv_max ?? 'unknown'})`);
    }
    const basePerformance = getPerformance(character, 'base');
    const ezaPerformance = getPerformance(character, 'eza');
    const imageURL = await downloadCharacterThumb(character.id);
    const isLR = isLegendaryRare(character);
    return {
        transformedID: character.id,
        transformedName: cleanName(character.name ?? character.full_name) ?? 'Error',
        transformedClass: character_1.Classes[character.class],
        transformedType: character_1.Types[character.type],
        transformedSuperAttack: describeSuperAttack(basePerformance?.super_attack),
        ...(character.eza ? {
            transformedEZASuperAttack: describeSuperAttack(ezaPerformance?.super_attack, undefined),
        } : {}),
        ...(isLR ? {
            transformedUltraSuperAttack: describeSuperAttack(basePerformance?.ultra_super_attack, undefined),
        } : {}),
        ...(character.eza && isLR ? {
            transformedEZAUltraSuperAttack: describeSuperAttack(ezaPerformance?.ultra_super_attack, undefined),
        } : {}),
        transformedPassive: describePassive(basePerformance?.passive_skill),
        ...(character.eza ? {
            transformedEZAPassive: describePassive(ezaPerformance?.passive_skill, undefined),
        } : {}),
        transformedActiveSkill: describeActiveSkill(basePerformance?.active_skill, 'effect_description'),
        transformedActiveSkillCondition: describeActiveSkill(basePerformance?.active_skill, 'condition_description'),
        transformedLinks: (character.links ?? []).map(link => link.name),
        transformedImageURL: imageURL,
    };
}
function getTransformationIds(character) {
    const ids = character.all_transformations?.length
        ? character.all_transformations
        : [
            ...(character.transformations ?? []),
            ...(character.reversible_exchange ?? []),
            ...(character.giant_ape ?? []),
        ];
    return Array.from(new Set(ids.map(id => Number(id))))
        .filter(id => Number.isFinite(id) && id !== character.id);
}
function getPerformance(character, key) {
    return character.performances?.[key];
}
function getMaxSuperAttackLevel(character) {
    const levels = Object.values(character.performances ?? {})
        .map(performance => performance.max_sa_lvl)
        .filter((level) => typeof level === 'number');
    return levels.length ? Math.max(...levels) : null;
}
function isSupportedRarity(rarity) {
    return rarity === character_1.Rarities.LR || rarity === character_1.Rarities.UR;
}
function isLegendaryRare(character) {
    return character.rarity === character_1.Rarities.LR;
}
function isScrapableCharacterSummary(character) {
    return isSupportedRarity(character.rarity) && hasScrapableMaxLevel(character);
}
function hasScrapableMaxLevel(character) {
    return typeof character.lv_max === 'number' && character.lv_max >= 120;
}
function isFinalAwakeningForm(character) {
    return !(character.awakening_routes ?? []).some(route => route.from_card_id === character.id
        && route.to_card_id != null
        && route.to_card_id !== character.id);
}
function describeSkill(skill, fallback = 'Error') {
    return cleanText(skill?.description) ?? fallback;
}
function describeSuperAttack(superAttack, fallback = 'Error') {
    const attacks = Array.isArray(superAttack) ? superAttack : superAttack ? [superAttack] : [];
    const descriptions = attacks
        .map(attack => cleanText(attack.description))
        .filter((description) => Boolean(description));
    return descriptions.length ? descriptions.join('\n') : fallback;
}
function describeActiveSkill(activeSkill, key) {
    const skills = Array.isArray(activeSkill) ? activeSkill : activeSkill ? [activeSkill] : [];
    const descriptions = skills
        .map(skill => cleanText(skill[key]))
        .filter((description) => Boolean(description));
    return descriptions.length ? descriptions.join('\n') : undefined;
}
function describePassive(passive, fallback = 'Error') {
    if (!passive) {
        return fallback;
    }
    const groups = [
        ...(passive.effects_grouped ?? []),
        ...(passive.mode_exclusive_effects ?? []),
        ...(passive.node_exclusive_effects ?? []),
    ];
    const descriptions = groups
        .map(group => {
        const groupName = cleanText(group.group_name);
        const effects = (group.effects ?? [])
            .map(effect => cleanText(effect.description))
            .filter((description) => Boolean(description));
        if (!effects.length) {
            return undefined;
        }
        return groupName ? `${groupName}- ${effects.join('\n')}` : effects.join('\n');
    })
        .filter((description) => Boolean(description));
    return descriptions.length ? descriptions.join('\n') : fallback;
}
function cleanText(value) {
    const cleaned = value
        ?.replace(/\{passiveImg:[^}]+}/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\r/g, '')
        .replace(/[ \t]*\n[ \t]*/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
    return cleaned || undefined;
}
function cleanName(value) {
    return cleanText(value)
        ?.replace(/\s*\/\s*/g, '/')
        .replace(/\s+([),])/g, '$1')
        .replace(/([(])\s+/g, '$1');
}
function numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : null;
}
async function downloadCharacterThumb(id) {
    const filename = `${id}.png`;
    const absolutePath = (0, path_1.resolve)(THUMB_DIRECTORY, filename);
    const relativePath = `images/thumbs/${filename}`;
    if ((0, fs_1.existsSync)(absolutePath)) {
        return relativePath;
    }
    if (!(0, fs_1.existsSync)((0, path_1.dirname)(absolutePath))) {
        (0, fs_1.mkdirSync)((0, path_1.dirname)(absolutePath), { recursive: true });
    }
    const thumbId = id - 1;
    const sourceUrl = `${DOKKANSTATS_ASSET_BASE_URL}/character/thumb/card_${thumbId}_thumb/card_${thumbId}_thumb.png`;
    const response = await requestWithRetry(`GET ${sourceUrl}`, () => axios_1.default.get(sourceUrl, {
        headers: REQUEST_HEADERS,
        responseType: 'arraybuffer',
    }));
    await (0, promises_1.writeFile)(absolutePath, Buffer.from(response.data));
    return relativePath;
}
function describeError(error) {
    if (axios_1.default.isAxiosError(error)) {
        const status = error.response?.status;
        return status ? `${error.message} (${status})` : error.message;
    }
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=dokkanstatsScraper.js.map