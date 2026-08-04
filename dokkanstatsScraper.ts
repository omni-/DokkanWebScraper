import axios from 'axios';
import { existsSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { Character, Classes, Rarities, Transformation, Types } from './character';

const DOKKANSTATS_BASE_URL = 'https://dokkanstats.com';
const DOKKANSTATS_ASSET_BASE_URL = 'https://assets.dokkanstats.com/assets/global/en';
// Both endpoints moved under /api/data in 2026. The old ones don't fail loudly: /api/kv/en/cards
// 404s per card, and /en/maxcharacters.json still returns 200 but stopped being updated in June,
// so the scrape silently missed every LR released after that.
const MAX_CHARACTERS_URL = `${DOKKANSTATS_BASE_URL}/api/data/en/allcharacters`;
const CARD_API_URL = `${DOKKANSTATS_BASE_URL}/api/data/en/cards`;
const DEFAULT_CONCURRENCY = parseInt(process.env.DOKKANSTATS_CONCURRENCY ?? '4', 10);
const MAX_RETRIES = parseInt(process.env.DOKKANSTATS_MAX_RETRIES ?? '5', 10);
const RETRY_BASE_DELAY_MS = parseInt(process.env.DOKKANSTATS_RETRY_BASE_DELAY_MS ?? '1000', 10);
const RETRY_MAX_DELAY_MS = parseInt(process.env.DOKKANSTATS_RETRY_MAX_DELAY_MS ?? '30000', 10);
const FORBIDDEN_RETRY_DELAY_MS = parseInt(process.env.DOKKANSTATS_403_RETRY_DELAY_MS ?? '5000', 10);
// A retired index endpoint keeps returning 200 with data that just stops growing, which is
// indistinguishable from a good scrape until someone notices a missing unit months later.
// Dokkan ships new URs/LRs most months, so a quiet index is a broken index.
const MAX_INDEX_AGE_DAYS = parseInt(process.env.DOKKANSTATS_MAX_INDEX_AGE_DAYS ?? '60', 10);
const OUTPUT_ROOT = process.cwd();
const THUMB_DIRECTORY = resolve(OUTPUT_ROOT, 'data/images/thumbs');
const REQUEST_HEADERS = {
    'Accept': 'application/json,text/plain,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
};

interface DokkanStatsIndexCharacter {
    id: number;
    lv_max?: number;
    rarity: string;
    /** e.g. "2026-07-29 05:00:00" */
    release_date?: string | null;
}

interface DokkanStatsNamedValue {
    id: number;
    name: string;
}

interface DokkanStatsStats {
    hp?: number;
    atk?: number;
    def?: number;
}

interface DokkanStatsSkill {
    name?: string;
    description?: string;
}

interface DokkanStatsPassiveEffect {
    description?: string;
}

interface DokkanStatsPassiveGroup {
    group_name?: string;
    effects?: DokkanStatsPassiveEffect[];
}

interface DokkanStatsPassiveSkill {
    name?: string;
    effects_grouped?: DokkanStatsPassiveGroup[];
    mode_exclusive_effects?: DokkanStatsPassiveGroup[];
    node_exclusive_effects?: DokkanStatsPassiveGroup[];
}

interface DokkanStatsSuperAttack {
    description?: string;
}

interface DokkanStatsActiveSkill {
    effect_description?: string;
    condition_description?: string;
}

interface DokkanStatsPerformance {
    max_sa_lvl?: number;
    stats_base?: DokkanStatsStats;
    stats_max?: DokkanStatsStats;
    stats_55?: DokkanStatsStats;
    stats_100?: DokkanStatsStats;
    leader_skill?: DokkanStatsSkill;
    passive_skill?: DokkanStatsPassiveSkill;
    super_attack?: DokkanStatsSuperAttack | DokkanStatsSuperAttack[];
    ultra_super_attack?: DokkanStatsSuperAttack | DokkanStatsSuperAttack[];
    active_skill?: DokkanStatsActiveSkill | DokkanStatsActiveSkill[];
}

interface DokkanStatsCharacter {
    id: number;
    lv_max?: number;
    name?: string;
    full_name?: string;
    dokkan_name?: string;
    rarity?: string;
    type?: string;
    class?: string;
    cost?: number;
    eza?: boolean;
    seza?: boolean;
    /** ATK multiplier at 12 ki, as a percentage. EZA never changes it, so it lives on the card. */
    ki_multiplier_12?: number;
    transformations?: number[];
    reversible_exchange?: number[];
    giant_ape?: number[];
    all_transformations?: number[];
    performances?: Record<string, DokkanStatsPerformance>;
    links?: DokkanStatsNamedValue[];
    categories?: DokkanStatsNamedValue[];
    awakening_routes?: DokkanStatsAwakeningRoute[];
}

interface DokkanStatsAwakeningRoute {
    from_card_id?: number;
    to_card_id?: number;
}

export async function getDokkanStatsData() {
    const indexCharacters = await fetchJson<DokkanStatsIndexCharacter[]>(MAX_CHARACTERS_URL);

    assertIndexIsFresh(indexCharacters);

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
        } catch (error) {
            console.warn(`Skipping DokkanStats character ${id}: ${describeError(error)}`);
            return null;
        }
    });

    return characters.filter((character): character is Character => character != null);
}

export async function getDokkanStatsCharacterData(id: number) {
    const character = await fetchDokkanStatsCharacter(id);
    if (!isFinalAwakeningForm(character)) {
        return null;
    }

    return mapDokkanStatsCharacter(character);
}

export async function saveDokkanStatsResults() {
    const data = await getDokkanStatsData();
    const now = new Date();
    const day = String(now.getUTCDate()).padStart(2, '0');
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const year = now.getUTCFullYear();

    await saveData(`${year}${month}${day}DokkanCharacterData`, data);
}

async function fetchDokkanStatsCharacter(id: number) {
    return fetchJson<DokkanStatsCharacter>(`${CARD_API_URL}/${id}`);
}

async function fetchJson<T>(url: string): Promise<T> {
    const response = await requestWithRetry(`GET ${url}`, () => axios.get<T>(url, { headers: REQUEST_HEADERS }));
    return response.data;
}

async function requestWithRetry<T>(label: string, request: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    let attempt = 1;

    while (true) {
        try {
            return await request();
        } catch (error) {
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

function shouldRetryRequest(error: unknown) {
    if (!axios.isAxiosError(error)) {
        return false;
    }

    const status = error.response?.status;
    return status == null || status === 403 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function getRetryDelay(attempt: number) {
    const exponentialDelay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    const jitter = Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
    return exponentialDelay + jitter;
}

function getForbiddenRetryDelay() {
    const jitter = Math.floor(Math.random() * 1000);
    return FORBIDDEN_RETRY_DELAY_MS + jitter;
}

function getAxiosStatus(error: unknown) {
    return axios.isAxiosError(error) ? error.response?.status : undefined;
}

function sleep(milliseconds: number) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function saveData(fileName: string, data: unknown) {
    const dataDirectory = resolve(OUTPUT_ROOT, 'data');
    if (!existsSync(dataDirectory)) {
        mkdirSync(dataDirectory, { recursive: true });
    }

    await writeFile(
        resolve(dataDirectory, `${fileName}.json`),
        JSON.stringify(data, null, 2),
        { encoding: 'utf8' },
    );
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

async function mapDokkanStatsCharacter(character: DokkanStatsCharacter): Promise<Character | null> {
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
        rarity: Rarities[character.rarity as keyof typeof Rarities],
        class: Classes[character.class as keyof typeof Classes],
        type: Types[character.type as keyof typeof Types],
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
        kiMultiplier: describeKiMultiplier(character),
        transformations,
    };
}

async function mapTransformations(character: DokkanStatsCharacter) {
    const transformationIds = getTransformationIds(character);
    return mapWithConcurrency(transformationIds, DEFAULT_CONCURRENCY, async id => {
        try {
            const transformedCharacter = await fetchDokkanStatsCharacter(id);
            return mapTransformedCharacter(transformedCharacter);
        } catch (error) {
            console.warn(`Skipping DokkanStats transformation ${id} for ${character.id}: ${describeError(error)}`);
            return null;
        }
    }).then(transformations => transformations.filter((transformation): transformation is Transformation => transformation != null));
}

async function mapTransformedCharacter(character: DokkanStatsCharacter): Promise<Transformation> {
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
        transformedClass: Classes[character.class as keyof typeof Classes],
        transformedType: Types[character.type as keyof typeof Types],
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

function getTransformationIds(character: DokkanStatsCharacter) {
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

function getPerformance(character: DokkanStatsCharacter, key: string) {
    return character.performances?.[key];
}

function getMaxSuperAttackLevel(character: DokkanStatsCharacter) {
    const levels = Object.values(character.performances ?? {})
        .map(performance => performance.max_sa_lvl)
        .filter((level): level is number => typeof level === 'number');

    return levels.length ? Math.max(...levels) : null as unknown as number;
}

function isSupportedRarity(rarity?: string) {
    return rarity === Rarities.LR || rarity === Rarities.UR;
}

function isLegendaryRare(character: { rarity?: string }) {
    return character.rarity === Rarities.LR;
}

/**
 * Throws when the newest release in the index is older than MAX_INDEX_AGE_DAYS, which means the
 * endpoint has been retired and is serving a frozen snapshot rather than that nothing shipped.
 * Runs before any card is fetched so a dead endpoint fails in seconds instead of an hour.
 */
export function assertIndexIsFresh(indexCharacters: DokkanStatsIndexCharacter[], now = new Date()) {
    const newest = getNewestReleaseDate(indexCharacters);

    if (newest == null) {
        throw new Error(`${MAX_CHARACTERS_URL} returned no usable release dates. The endpoint has probably changed shape.`);
    }

    const ageInDays = Math.floor((now.getTime() - newest.getTime()) / (1000 * 60 * 60 * 24));

    if (ageInDays > MAX_INDEX_AGE_DAYS) {
        throw new Error(
            `${MAX_CHARACTERS_URL} looks stale: its newest release is ${newest.toISOString().slice(0, 10)}, `
            + `${ageInDays} days ago (limit ${MAX_INDEX_AGE_DAYS}). DokkanStats has most likely moved the index `
            + 'endpoint again - check what the site fetches on a card page. Set DOKKANSTATS_MAX_INDEX_AGE_DAYS '
            + 'to override if the game really has gone quiet.');
    }

    console.log(`Index looks current: newest release ${newest.toISOString().slice(0, 10)} (${ageInDays} days ago)`);
}

function getNewestReleaseDate(indexCharacters: DokkanStatsIndexCharacter[]) {
    const timestamps = indexCharacters
        .map(character => parseReleaseDate(character.release_date))
        .filter((value): value is number => value != null);

    return timestamps.length === 0 ? null : new Date(Math.max(...timestamps));
}

// "2026-07-29 05:00:00" is not something Date.parse handles portably; treat it as UTC.
function parseReleaseDate(value?: string | null) {
    if (!value) return null;

    const parsed = Date.parse(`${value.trim().replace(' ', 'T')}Z`);

    return Number.isNaN(parsed) ? null : parsed;
}

function isScrapableCharacterSummary(character: DokkanStatsIndexCharacter) {
    return isSupportedRarity(character.rarity) && hasScrapableMaxLevel(character) && isStandaloneCard(character);
}

// Cards in the 4xxxxxx range are transformed battle forms, not units you can field directly.
// They already ride along inside their base card's `transformations`, and the old maxcharacters
// index never listed them; the allcharacters index does, so filter them out here.
function isStandaloneCard(character: DokkanStatsIndexCharacter) {
    return character.id < 4000000;
}

function hasScrapableMaxLevel(character: { lv_max?: number }) {
    return typeof character.lv_max === 'number' && character.lv_max >= 120;
}

function isFinalAwakeningForm(character: DokkanStatsCharacter) {
    return !(character.awakening_routes ?? []).some(route =>
        route.from_card_id === character.id
        && route.to_card_id != null
        && route.to_card_id !== character.id
    );
}

function describeSkill(skill?: DokkanStatsSkill, fallback = 'Error') {
    return cleanText(skill?.description) ?? fallback;
}

function describeSuperAttack(
    superAttack?: DokkanStatsSuperAttack | DokkanStatsSuperAttack[],
    fallback = 'Error',
) {
    const attacks = Array.isArray(superAttack) ? superAttack : superAttack ? [superAttack] : [];
    const descriptions = attacks
        .map(attack => cleanText(attack.description))
        .filter((description): description is string => Boolean(description));

    return descriptions.length ? descriptions.join('\n') : fallback;
}

function describeActiveSkill(
    activeSkill: DokkanStatsActiveSkill | DokkanStatsActiveSkill[] | undefined,
    key: keyof DokkanStatsActiveSkill,
) {
    const skills = Array.isArray(activeSkill) ? activeSkill : activeSkill ? [activeSkill] : [];
    const descriptions = skills
        .map(skill => cleanText(skill[key]))
        .filter((description): description is string => Boolean(description));

    return descriptions.length ? descriptions.join('\n') : undefined;
}

/**
 * Keeps the wiki scraper's wording so downstream consumers see the same shape. Only the 12 ki
 * value is sourced - the 24 ki multiplier every LR quotes is a flat 200%, so it isn't in the API.
 */
function describeKiMultiplier(character: DokkanStatsCharacter) {
    const kiMultiplier = character.ki_multiplier_12;

    if (typeof kiMultiplier !== 'number' || !Number.isFinite(kiMultiplier)) {
        console.warn(`No ki_multiplier_12 on DokkanStats character ${character.id}; leaving kiMultiplier unset.`);
        return null as unknown as string;
    }

    return `12 Ki Multiplier is ${kiMultiplier}%`;
}

function describePassive(passive?: DokkanStatsPassiveSkill, fallback = 'Error') {
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
                .filter((description): description is string => Boolean(description));

            if (!effects.length) {
                return undefined;
            }

            return groupName ? `${groupName}- ${effects.join('\n')}` : effects.join('\n');
        })
        .filter((description): description is string => Boolean(description));

    return descriptions.length ? descriptions.join('\n') : fallback;
}

function cleanText(value?: string) {
    const cleaned = value
        ?.replace(/\{passiveImg:[^}]+}/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\r/g, '')
        .replace(/[ \t]*\n[ \t]*/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();

    return cleaned || undefined;
}

function cleanName(value?: string) {
    return cleanText(value)
        ?.replace(/\s*\/\s*/g, '/')
        .replace(/\s+([),])/g, '$1')
        .replace(/([(])\s+/g, '$1');
}

function numberOrNull(value?: number) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : null as unknown as number;
}

async function downloadCharacterThumb(id: number) {
    const filename = `${id}.png`;
    const absolutePath = resolve(THUMB_DIRECTORY, filename);
    const relativePath = `images/thumbs/${filename}`;

    if (existsSync(absolutePath)) {
        return relativePath;
    }

    if (!existsSync(dirname(absolutePath))) {
        mkdirSync(dirname(absolutePath), { recursive: true });
    }

    const thumbId = id - 1;
    const sourceUrl = `${DOKKANSTATS_ASSET_BASE_URL}/character/thumb/card_${thumbId}_thumb/card_${thumbId}_thumb.png`;
    const response = await requestWithRetry(`GET ${sourceUrl}`, () => axios.get<ArrayBuffer>(sourceUrl, {
        headers: REQUEST_HEADERS,
        responseType: 'arraybuffer',
    }));

    await writeFile(absolutePath, Buffer.from(response.data));
    return relativePath;
}

function describeError(error: unknown) {
    if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        return status ? `${error.message} (${status})` : error.message;
    }

    return error instanceof Error ? error.message : String(error);
}
