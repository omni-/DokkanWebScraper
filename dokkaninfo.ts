import { execFile } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { JSDOM } from 'jsdom';
import { dirname, resolve } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const BASE_URL = 'https://dokkaninfo.com';
const ASSET_BASE_URL = `${BASE_URL}/assets/global/en/ingame/events`;
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
}

export interface ChallengeEventSummary {
    id: number;
    name: string;
    wallUrl: string;
    bannerUrl: string;
    url: string;
}

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
            bannerUrl: assetUrl(area.banner_image_path, `quest_list_banner_${area.id}.png`),
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

function assetUrl(imagePath: string | undefined, fallbackFileName: string) {
    const fileName = (imagePath ?? '').split('/').pop() || fallbackFileName;

    return `${ASSET_BASE_URL}/${fileName}`;
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
    const names: string[] = [];

    for (const element of document.querySelectorAll('div')) {
        if (element.children.length > 0) continue;

        const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
        const match = /^Level (\d+):\s*(.*)$/.exec(text);

        if (match) names.push(match[2].trim());
    }

    return names;
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

  cards         Classifies cards as premium (summon-only) or free-to-play.
  events        Lists challenge events with stage counts and whether they are permanent.
  event-images  Downloads banner.png + wall.png for one event into <directory>.`;

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
