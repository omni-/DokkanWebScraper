import { execFile } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { JSDOM } from 'jsdom';
import { dirname, resolve } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const BASE_URL = 'https://dokkaninfo.com';
const ASSET_BASE_URL = `${BASE_URL}/assets/global/en/ingame/events`;
const LIST_BANNER_ASSET_BASE_URL = 'https://cdn.dokkan.fyi/assets/en/banners/en/event/eve_listbutton';

// dokkaninfo knows which stages an event has but nothing about the enemies in them. DokkanDB is
// the only source for enemy skills, so `bosses` reads stage ids from dokkaninfo and everything
// else from here.
const DOKKANDB_API_URL = 'https://api.dokkandb.com/api';
const DOKKANDB_STAGE_URL = 'https://www.dokkandb.com/events/challenge';
const DEFAULT_CONCURRENCY = parseInt(process.env.DOKKANINFO_CONCURRENCY ?? '4', 10);
const MAX_RETRIES = parseInt(process.env.DOKKANINFO_MAX_RETRIES ?? '4', 10);
const RETRY_BASE_DELAY_MS = parseInt(process.env.DOKKANINFO_RETRY_BASE_DELAY_MS ?? '1000', 10);
const RETRY_MAX_DELAY_MS = parseInt(process.env.DOKKANINFO_RETRY_MAX_DELAY_MS ?? '20000', 10);

// Dokkan uses 2037-12-31 as its "this never ends" sentinel. Anything ending materially
// sooner than that is a limited-time event.
const PERMANENT_END_AT = 2145916800;
const PERMANENT_THRESHOLD = PERMANENT_END_AT - 60 * 60 * 24 * 365;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

// dokkaninfo.com sits behind Cloudflare, which 403s Node's TLS/ALPN fingerprint no matter
// what headers we send (verified against axios, global fetch and raw http2). curl gets
// through, so every request here goes out through the curl binary.
const CURL_BASE_ARGS = [
    '--silent',
    '--show-error',
    '--location',
    '--compressed',
    '--fail',
    '--max-time', process.env.DOKKANINFO_TIMEOUT_SECONDS ?? '60',
    '--user-agent', USER_AGENT,
    '--header', 'Accept-Language: en-US,en;q=0.9',
];

export type Obtainment = 'Summonable' | 'FreeToPlay' | 'Unknown';

export interface BannerRef {
    id: number;
    type: string;
    name: string;
    openAt: number;
    endAt: number;
}

export interface CardMeta {
    id: number;
    name: string;
    title: string;
    obtainment: Obtainment;
    /** True when the card can only be obtained from a summon banner (i.e. not F2P). */
    isPremium: boolean;
    /** Set when the card is on at least one Dragon Stone banner (Dokkan Fest / LR Carnival / etc). */
    isStoneGasha: boolean;
    banners: BannerRef[];
}

export interface ChallengeEvent {
    id: number;
    /** English event name exactly as DokkanDaily's Stage.Name needs it. */
    name: string;
    stageCount: number;
    stageNames: string[];
    /** False when the event has a real end date, i.e. it will go away. */
    isPermanent: boolean;
    /** Latest mission end date (unix seconds), or null when the event has no missions. */
    endsAt: number | null;
    /** 852x610 event art -> DokkanDaily's wall.png */
    wallUrl: string;
    /** 600x120 event banner -> DokkanDaily's banner.png */
    bannerUrl: string;
    url: string;
}

interface DokkanInfoBanner {
    id: number;
    type?: string;
    name?: string;
    open_at?: number;
    end_at?: number;
}

interface DokkanInfoCardData {
    summonable?: string | null;
    banners?: DokkanInfoBanner[];
    card?: { id?: number; name?: string };
}

interface DokkanInfoMission {
    start_at?: number;
    end_at?: number;
}

interface DokkanInfoMissionCategory {
    id?: number;
    missions?: DokkanInfoMission[];
}

interface DokkanInfoEventArea {
    id: number;
    name?: string;
    /** e.g. "banners/en/event/eve_header/quest_top_banner_1766.png" */
    event_image_path?: string;
    /** e.g. "quest_list_banner_1766.png" */
    banner_image_path?: string;
    /** e.g. "banners/en/event/eve_listbutton/myp_banner_event_1766.png" */
    listbutton_image_path?: string;
}

export interface ChallengeEventSummary {
    id: number;
    name: string;
    wallUrl: string;
    bannerUrl: string;
    url: string;
}

export interface EnemySkill {
    id: number;
    name: string;
    /** DokkanDB's own wording, with the percentage folded back in when the text omits it. */
    description: string;
    /** 0 for skills that are always on; DokkanDB renders these without a chance. */
    probability: number;
    /**
     * True for the four lines every Red Zone / Supreme Magnificent Battle boss carries. They say
     * nothing about how hard a stage is, so tier on what a boss has beyond them.
     */
    isBoilerplate: boolean;
}

export interface StageEnemy {
    cardId: number;
    name: string;
    skills: EnemySkill[];
}

export interface StageRound {
    roundNumber: number;
    enemies: StageEnemy[];
}

export interface EventStage {
    id: number;
    /** 1-based, matching the "Level N:" heading and DokkanDaily's Stage.stage. */
    level: number;
    name: string;
    difficulty: number | null;
    rounds: StageRound[];
    /**
     * DokkanDB renders per-phase HP/ATK/DEF, actions per turn and super attack damage on this
     * page, but serves none of it from the API - open it in a browser when a stage sits on a
     * tier boundary and the numbers would decide it.
     */
    url: string;
}

export interface EventBosses {
    eventId: number;
    name: string;
    stages: EventStage[];
}

interface DokkanDbSkill {
    id: number;
    name?: string;
    description?: string;
    probability?: number;
    eff_value1?: number | null;
}

interface DokkanDbCard {
    id: number;
    name?: string;
}

interface DokkanDbEventStats {
    quest_name?: string;
    name?: string;
    difficulty?: number;
    /** A JSON *string*, not an object. */
    enemy_info?: string;
}

interface DokkanDbEnemyInfo {
    battles?: {
        rounds?: {
            round_no?: number;
            enemies?: { card_id: number; enemy_skill_ids?: number[] }[];
        }[];
    }[];
}

// Matched on text rather than id so a DokkanDB reshuffle degrades to "nothing is boilerplate"
// instead of silently mislabelling a real mechanic.
const BOILERPLATE_SKILLS = new Set([
    'Reduces damage received',
    'Disables ATK & DEF Reduction',
    'Grants immunity to being stunned',
    'Nullifies Super Attack sealing effect',
]);

export async function fetchCardMeta(id: number): Promise<CardMeta> {
    const document = await fetchDocument(`${BASE_URL}/cards/${id}`);
    const data = readComponentProp<DokkanInfoCardData>(document, 'card-info', 'v-bind:datajson') ?? {};

    const banners = (data.banners ?? []).map(banner => ({
        id: banner.id,
        type: banner.type ?? '',
        name: banner.name ?? '',
        openAt: banner.open_at ?? 0,
        endAt: banner.end_at ?? 0,
    }));

    const obtainment = normalizeObtainment(data.summonable);
    const { name, title } = splitCardTitle(document, data.card?.name);

    return {
        id,
        name,
        title,
        obtainment,
        isPremium: obtainment === 'Summonable',
        isStoneGasha: banners.some(x => x.type === 'Gasha::StoneGasha'),
        banners,
    };
}

export async function fetchCardMetas(ids: number[], concurrency = DEFAULT_CONCURRENCY) {
    return mapWithConcurrency(ids, concurrency, async (id, index) => {
        console.error(`Fetching card ${index + 1}/${ids.length}: ${id}`);
        try {
            return await fetchCardMeta(id);
        } catch (error) {
            console.error(`Failed to fetch card ${id}: ${describeError(error)}`);
            return {
                id,
                name: '',
                title: '',
                obtainment: 'Unknown',
                isPremium: false,
                isStoneGasha: false,
                banners: [],
            } as CardMeta;
        }
    });
}

/**
 * The challenge list page renders its links client-side, but ships the whole event list as a
 * prop on <events>, which is both cheaper and gives us the exact asset filenames.
 */
export async function listChallengeEventSummaries(): Promise<ChallengeEventSummary[]> {
    const document = await fetchDocument(`${BASE_URL}/events/challenge`);
    const areas = readComponentProp<DokkanInfoEventArea[]>(document, 'events', 'v-bind:eventjson') ?? [];

    return areas
        .filter(area => Number.isFinite(area.id))
        .map(area => ({
            id: area.id,
            name: (area.name ?? '').replace(/\s+/g, ' ').trim(),
            wallUrl: assetUrl(area.event_image_path, `quest_top_banner_${area.id}.png`),
            bannerUrl: listBannerUrl(area.listbutton_image_path, area.id),
            url: `${BASE_URL}/events/challenge/${area.id}`,
        }))
        .sort((a, b) => a.id - b.id);
}

export async function fetchChallengeEvent(id: number, summary?: ChallengeEventSummary): Promise<ChallengeEvent> {
    const resolved = summary ?? (await listChallengeEventSummaries()).find(x => x.id === id);
    const url = `${BASE_URL}/events/challenge/${id}`;
    const document = await fetchDocument(url);

    const stageNames = extractStageNames(document);
    const missionCategory = readComponentProp<DokkanInfoMissionCategory>(document, 'mission-category', 'v-bind:missioncategory');
    const endsAt = getLatestMissionEnd(missionCategory);

    return {
        id,
        name: resolved?.name || extractEventName(document),
        stageCount: stageNames.length,
        stageNames,
        isPermanent: endsAt != null && endsAt >= PERMANENT_THRESHOLD,
        endsAt,
        wallUrl: resolved?.wallUrl ?? `${ASSET_BASE_URL}/quest_top_banner_${id}.png`,
        bannerUrl: resolved?.bannerUrl ?? `${ASSET_BASE_URL}/quest_list_banner_${id}.png`,
        url,
    };
}

export async function listChallengeEvents(options: { since?: number; concurrency?: number } = {}) {
    const summaries = (await listChallengeEventSummaries()).filter(x => x.id >= (options.since ?? 0));

    const events = await mapWithConcurrency(summaries, options.concurrency ?? DEFAULT_CONCURRENCY, async (summary, index) => {
        console.error(`Fetching challenge event ${index + 1}/${summaries.length}: ${summary.id} (${summary.name})`);
        try {
            return await fetchChallengeEvent(summary.id, summary);
        } catch (error) {
            console.error(`Failed to fetch challenge event ${summary.id}: ${describeError(error)}`);
            return null;
        }
    });

    return events.filter((event): event is ChallengeEvent => event != null);
}

/**
 * Stage ids for an event, read off the links on its dokkaninfo page. They also appear in a hidden
 * debug div, but the hrefs are the part of the page that has to keep working.
 */
export async function listEventStages(eventId: number) {
    const document = await fetchDocument(`${BASE_URL}/events/challenge/${eventId}`);
    const headings = extractStageHeadings(document);

    const ids: number[] = [];
    const pattern = new RegExp(`/events/challenge/${eventId}/(\\d+)\\b`);

    for (const anchor of document.querySelectorAll('a[href]')) {
        const match = pattern.exec(anchor.getAttribute('href') ?? '');
        const id = match ? parseInt(match[1], 10) : NaN;

        if (Number.isFinite(id) && !ids.includes(id)) ids.push(id);
    }

    if (ids.length !== headings.length) {
        console.error(`Event ${eventId}: found ${ids.length} stage link(s) but ${headings.length} "Level N:" heading(s); pairing by position.`);
    }

    return ids.map((id, index) => ({
        id,
        level: headings[index]?.level ?? index + 1,
        name: headings[index]?.name ?? `Stage ${index + 1}`,
    }));
}

/**
 * Every enemy in every stage of an event, with its skills resolved to text. This is what a stage
 * tier is judged on - see the skill's tiering reference.
 */
export async function fetchEventBosses(eventId: number): Promise<EventBosses> {
    const stageRefs = await listEventStages(eventId);
    const stats = await mapWithConcurrency(stageRefs, DEFAULT_CONCURRENCY, async (stage, index) => {
        console.error(`Fetching stage ${index + 1}/${stageRefs.length}: ${stage.id} (${stage.name})`);

        const rows = await requestWithRetry(
            `GET event-stats ${stage.id}`,
            () => fetchDokkanDbJson<DokkanDbEventStats[]>(`event-stats?code=${eventId}&code2=${stage.id}`),
        );

        return rows?.[0] ?? null;
    });

    const enemyInfos = stats.map(row => parseEnemyInfo(row?.enemy_info));

    // One round trip each for the whole event rather than one per round.
    const rounds = enemyInfos.flatMap(info => info.battles?.flatMap(battle => battle.rounds ?? []) ?? []);
    const enemies = rounds.flatMap(round => round.enemies ?? []);
    const skills = await fetchEnemySkills(enemies.flatMap(enemy => enemy.enemy_skill_ids ?? []));
    const names = await fetchEnemyNames(enemies.map(enemy => enemy.card_id));

    return {
        eventId,
        name: (stats.find(row => row?.name)?.name ?? '').trim(),
        stages: stageRefs.map((stage, index) => ({
            id: stage.id,
            level: stage.level,
            name: (stats[index]?.quest_name ?? stage.name).trim(),
            difficulty: stats[index]?.difficulty ?? null,
            url: `${DOKKANDB_STAGE_URL}/${eventId}/${stage.id}`,
            rounds: (enemyInfos[index].battles ?? []).flatMap(battle => battle.rounds ?? []).map((round, roundIndex) => ({
                roundNumber: round.round_no ?? roundIndex + 1,
                enemies: (round.enemies ?? []).map(enemy => ({
                    cardId: enemy.card_id,
                    name: names.get(enemy.card_id) ?? '',
                    skills: (enemy.enemy_skill_ids ?? [])
                        .map(id => skills.get(id))
                        .filter((skill): skill is EnemySkill => skill != null),
                })),
            })),
        })),
    };
}

async function fetchEnemySkills(ids: number[]) {
    const rows = await fetchDokkanDbByIds<DokkanDbSkill>('enemy-skills-by-ids', ids);
    const skills = new Map<number, EnemySkill>();

    for (const row of rows) {
        const description = describeSkill(row);

        skills.set(row.id, {
            id: row.id,
            name: (row.name ?? '').trim(),
            description,
            probability: row.probability ?? 0,
            isBoilerplate: BOILERPLATE_SKILLS.has((row.description ?? '').trim()),
        });
    }

    return skills;
}

async function fetchEnemyNames(ids: number[]) {
    const rows = await fetchDokkanDbByIds<DokkanDbCard>('cards-by-ids', ids);

    return new Map(rows.map(row => [row.id, (row.name ?? '').trim()]));
}

/**
 * DokkanDB writes most percentages into the description, but leaves them out of a handful of
 * stock lines ("Reduces damage received") and renders eff_value1 beside them instead. Fold it
 * back in so the caller never has to know which kind it is holding.
 *
 * A few skills ("Deactivate ...") carry no description at all and say everything in the name.
 * Those fall back to the name untouched - their eff_value1 is not a percentage.
 */
function describeSkill(row: DokkanDbSkill) {
    const description = collapse(row.description);

    if (!description) return collapse(row.name);
    if (/\d/.test(description) || row.eff_value1 == null || row.eff_value1 === 0) return description;

    return `${description} (${row.eff_value1}%)`;
}

function collapse(value?: string | null) {
    return (value ?? '').replace(/\s*\n\s*/g, ' ').trim();
}

function parseEnemyInfo(raw?: string): DokkanDbEnemyInfo {
    if (!raw) return {};

    try {
        return JSON.parse(raw) as DokkanDbEnemyInfo;
    } catch (error) {
        console.error(`Could not parse enemy_info: ${describeError(error)}`);
        return {};
    }
}

async function fetchDokkanDbByIds<T>(endpoint: string, ids: number[]) {
    const unique = [...new Set(ids.filter(id => Number.isFinite(id)))];
    const rows: T[] = [];

    // Long id lists have to be chunked or the query string outgrows what the API will take.
    for (let i = 0; i < unique.length; i += 100) {
        const chunk = unique.slice(i, i + 100);
        const batch = await requestWithRetry(
            `GET ${endpoint} (${chunk.length} ids)`,
            () => fetchDokkanDbJson<T[]>(`${endpoint}?ids=${chunk.join(',')}`),
        );

        if (batch) rows.push(...batch);
    }

    return rows;
}

async function fetchDokkanDbJson<T>(path: string): Promise<T | null> {
    const body = await curl([...CURL_BASE_ARGS, `${DOKKANDB_API_URL}/${path}`]);

    try {
        return JSON.parse(body) as T;
    } catch (error) {
        throw new Error(`${path} did not return JSON: ${describeError(error)}`);
    }
}

function assetUrl(imagePath: string | undefined, fallbackFileName: string) {
    const fileName = (imagePath ?? '').split('/').pop() || fallbackFileName;

    return `${ASSET_BASE_URL}/${fileName}`;
}

/** DokkanDaily uses the game's 500x110 event-list button, not DokkanInfo's 600x120 banner. */
export function listBannerUrl(imagePath: string | undefined, eventId: number) {
    const fileName = (imagePath ?? '').split('/').pop() || `myp_banner_event_${eventId}.png`;

    return `${LIST_BANNER_ASSET_BASE_URL}/${fileName}`;
}

/**
 * Writes the two images DokkanDaily expects for a Stage: banner.png (event banner) and
 * wall.png (852x610 event art). Returns the paths written.
 */
export async function downloadEventImages(eventId: number, outDirectory: string) {
    const event = await fetchChallengeEvent(eventId);
    const targets = [
        { url: event.bannerUrl, path: resolve(outDirectory, 'banner.png') },
        { url: event.wallUrl, path: resolve(outDirectory, 'wall.png') },
    ];

    for (const target of targets) {
        ensureDirectory(dirname(target.path));
        await requestWithRetry(`GET ${target.url}`, () => curl([...CURL_BASE_ARGS, '--output', target.path, target.url]));
    }

    return { event, files: targets.map(x => x.path) };
}

function extractEventName(document: Document) {
    const title = (document.querySelector('title')?.textContent ?? '').trim();

    return title.replace(/\s*\|\s*Dokkan Info!?\s*$/i, '').trim();
}

function extractStageNames(document: Document) {
    return extractStageHeadings(document).map(heading => heading.name);
}

function extractStageHeadings(document: Document) {
    const headings: { level: number; name: string }[] = [];

    for (const element of document.querySelectorAll('div')) {
        if (element.children.length > 0) continue;

        const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
        const match = /^Level (\d+):\s*(.*)$/.exec(text);

        if (match) headings.push({ level: parseInt(match[1], 10), name: match[2].trim() });
    }

    return headings;
}

function getLatestMissionEnd(missionCategory?: DokkanInfoMissionCategory | null) {
    const ends = (missionCategory?.missions ?? [])
        .map(mission => mission.end_at)
        .filter((value): value is number => typeof value === 'number');

    return ends.length === 0 ? null : Math.max(...ends);
}

function normalizeObtainment(value?: string | null): Obtainment {
    if (value === 'Summonable') return 'Summonable';
    if (value === 'FreeToPlay') return 'FreeToPlay';

    return 'Unknown';
}

function splitCardTitle(document: Document, fallbackName?: string) {
    const title = extractEventName(document);
    const match = /^\[(.*?)\]\s*(.*)$/.exec(title);

    if (match) return { title: match[1].trim(), name: match[2].trim() };

    return { title: '', name: (fallbackName ?? title).trim() };
}

function readComponentProp<T>(document: Document, tagName: string, attribute: string): T | null {
    const raw = document.querySelector(tagName)?.getAttribute(attribute);

    if (!raw) return null;

    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

async function fetchDocument(url: string) {
    const html = await requestWithRetry(`GET ${url}`, () => curl([...CURL_BASE_ARGS, url]));

    return new JSDOM(html).window.document;
}

async function curl(args: string[]) {
    try {
        const { stdout } = await execFileAsync('curl', args, { maxBuffer: 64 * 1024 * 1024 });
        return stdout;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;

        if (code === 'ENOENT') {
            throw new Error('curl was not found on PATH. dokkaninfo.com requires curl to get past Cloudflare.');
        }

        throw error;
    }
}

async function requestWithRetry<T>(label: string, request: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await request();
        } catch (error) {
            lastError = error;

            if (attempt === MAX_RETRIES) break;

            const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
                + Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
            console.error(`${label} failed (${describeError(error)}). Retrying in ${delay}ms (${attempt}/${MAX_RETRIES})`);
            await sleep(delay);
        }
    }

    throw lastError;
}

function sleep(milliseconds: number) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function ensureDirectory(path: string) {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

async function mapWithConcurrency<T, TResult>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<TResult>,
) {
    const results = new Array<TResult>(items.length);
    let nextIndex = 0;

    const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, async () => {
        while (nextIndex < items.length) {
            const currentIndex = nextIndex++;
            results[currentIndex] = await mapper(items[currentIndex], currentIndex);
        }
    });

    await Promise.all(workers);

    return results;
}

function describeError(error: unknown) {
    const stderr = (error as { stderr?: string })?.stderr?.trim();

    if (stderr) return stderr;

    return error instanceof Error ? error.message : String(error);
}

function parseArgs(argv: string[]) {
    const args: Record<string, string> = {};

    for (let i = 0; i < argv.length; i++) {
        const current = argv[i];
        if (!current.startsWith('--')) continue;

        const [key, inlineValue] = current.slice(2).split('=');
        args[key] = inlineValue ?? (argv[i + 1]?.startsWith('--') === false ? argv[++i] : 'true');
    }

    return args;
}

async function emit(data: unknown, outPath?: string) {
    const json = JSON.stringify(data, null, 2);

    if (!outPath) {
        console.log(json);
        return;
    }

    ensureDirectory(dirname(resolve(outPath)));
    await writeFile(resolve(outPath), json, { encoding: 'utf8' });
    console.error(`Wrote ${outPath}`);
}

const USAGE = `Usage:
  npm run run:dokkaninfo -- cards --ids 1033821,1034221 [--out data/cardMeta.json]
  npm run run:dokkaninfo -- events [--since 1700] [--permanent-only] [--out data/challengeEvents.json]
  npm run run:dokkaninfo -- event-images --id 1766 --out <directory>
  npm run run:dokkaninfo -- bosses --id 1766 [--all-skills] [--out data/bosses.json]

  cards         Classifies cards as premium (summon-only) or free-to-play.
  events        Lists challenge events with stage counts and whether they are permanent.
  event-images  Downloads banner.png + wall.png for one event into <directory>.
  bosses        Enemy skills for every stage of one event, for tiering it. Boilerplate skills
                (the four every Red Zone boss carries) are dropped unless --all-skills.`;

function withoutBoilerplate(bosses: EventBosses): EventBosses {
    return {
        ...bosses,
        stages: bosses.stages.map(stage => ({
            ...stage,
            rounds: stage.rounds.map(round => ({
                ...round,
                enemies: round.enemies.map(enemy => ({
                    ...enemy,
                    skills: enemy.skills.filter(skill => !skill.isBoilerplate),
                })),
            })),
        })),
    };
}

async function main() {
    const [command, ...rest] = process.argv.slice(2);
    const args = parseArgs(rest);

    switch (command) {
        case 'cards': {
            const ids = (args.ids ?? '')
                .split(',')
                .map(value => parseInt(value.trim(), 10))
                .filter(value => Number.isFinite(value));

            if (ids.length === 0) throw new Error('cards requires --ids with at least one card id');

            await emit(await fetchCardMetas(ids), args.out);
            break;
        }
        case 'events': {
            const since = args.since ? parseInt(args.since, 10) : undefined;
            const events = await listChallengeEvents({ since });

            await emit(args['permanent-only'] ? events.filter(x => x.isPermanent) : events, args.out);
            break;
        }
        case 'event-images': {
            const id = parseInt(args.id ?? '', 10);

            if (!Number.isFinite(id)) throw new Error('event-images requires --id');
            if (!args.out) throw new Error('event-images requires --out with the destination directory');

            const result = await downloadEventImages(id, args.out);
            await emit({ event: result.event, files: result.files });
            break;
        }
        case 'bosses': {
            const id = parseInt(args.id ?? '', 10);

            if (!Number.isFinite(id)) throw new Error('bosses requires --id with a challenge event id');

            const bosses = await fetchEventBosses(id);

            await emit(args['all-skills'] ? bosses : withoutBoilerplate(bosses), args.out);
            break;
        }
        default:
            console.log(USAGE);
            process.exitCode = command ? 1 : 0;
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(describeError(error));
        process.exitCode = 1;
    });
}
