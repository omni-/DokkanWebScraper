import { equal, deepStrictEqual, throws, rejects } from 'assert';
import { JSDOM } from 'jsdom';
import { describe, it } from 'mocha';
import { listBannerUrl, parseEventDirectory, parseEventStages, exportStageMetadata, listEventStages, fetchEventBosses } from './dokkaninfo';

describe('DokkanInfo event assets', function () {
    it('uses the 500x110 event-list button asset', function () {
        equal(
            listBannerUrl('banners/en/event/eve_listbutton/myp_banner_event_1752.png', 1752),
            'https://cdn.dokkan.fyi/assets/en/banners/en/event/eve_listbutton/myp_banner_event_1752.png',
        );
    });

    it('preserves asset suffixes and falls back to the event id', function () {
        equal(
            listBannerUrl('myp_banner_event_1768_A.png', 1768),
            'https://cdn.dokkan.fyi/assets/en/banners/en/event/eve_listbutton/myp_banner_event_1768_A.png',
        );
        equal(
            listBannerUrl(undefined, 1769),
            'https://cdn.dokkan.fyi/assets/en/banners/en/event/eve_listbutton/myp_banner_event_1769.png',
        );
    });
});

const doc = (html: string): Document => new JSDOM(html).window.document;
const fixture = `<section><div><b>Level 7:</b> Goku &amp; Vegeta
 Stage 2</div>
<a href="/events/challenge/701/7010073">HARD</a>
<a href="https://dokkaninfo.com/events/challenge/701/7010075">SUPER</a>
<a href="/events/challenge/701/7010075">duplicate</a>
<a href="https://other.example/events/challenge/701/7010075">fake</a>
<a href="/events/challenge/702/7020075">other event</a></section>
<section><div>Level 9: Next</div><a href="/events/challenge/701/7010095">SUPER</a></section>
<div hidden>Level 100: debug</div>`;
const directory = () => parseEventDirectory(doc(`<events v-bind:eventjson='[{"id":701,"name":"A &amp; B"}]'></events>`));

describe('DokkanDB boss completeness (offline)', () => {
    const enemyInfo = (ids: number[] = [42]) => JSON.stringify({ battles: [
        { rounds: [{ round_no: 1, enemies: [{ card_id: 123, enemy_skill_ids: ids }] }] },
    ] });
    const acquireDocument = async () => doc('<div>Level 1: Boss</div><a href="/events/challenge/701/7010015">SUPER</a>');
    async function fetchBosses(rows: unknown, skillRows = [{ id: 42, description: 'Dodges attacks' }]) {
        return fetchEventBosses(701, acquireDocument, async <T>(path: string): Promise<T> => {
            if (path.startsWith('event-stats?')) return rows as T;
            if (path.startsWith('enemy-skills-by-ids?')) return skillRows as T;
            if (path.startsWith('cards-by-ids?')) return [{ id: 123, name: 'Boss' }] as T;
            throw new Error(`Unexpected request: ${path}`);
        });
    }

    it('rejects absent stage stats and malformed or empty enemy data', async () => {
        for (const rows of [[], null, {}]) {
            await rejects(fetchBosses(rows), /Stage 7010015: missing DokkanDB event stats/);
        }
        for (const raw of [undefined, '', '{', 'null', '{}', '{"battles":[]}',
            '{"battles":[{"rounds":[]}]}', '{"battles":[{"rounds":[{"enemies":[]}]}]}',
            '{"battles":[{"rounds":[{"enemies":[{"card_id":123}]}]}]}',
            '{"battles":[{"rounds":[{"enemies":[{"card_id":123,"enemy_skill_ids":"42"}]}]}]}']) {
            await rejects(fetchBosses([{ enemy_info: raw }]), /Stage 7010015: .*enemy_info/);
        }
    });

    it('rejects unresolved skills, including partial and textless responses', async () => {
        for (const skills of [[], [{ id: 42, description: 'Dodges attacks' }],
            [{ id: 42, description: 'Dodges attacks' }, { id: 43, description: '' }]]) {
            await rejects(fetchBosses([{ enemy_info: enemyInfo([42, 43]) }], skills), /Stage 7010015: unresolved enemy skill/);
        }
        await rejects(fetchBosses([{ enemy_info: enemyInfo() }], null), /enemy-skills-by-ids: expected an array/);
    });

    it('retains resolved skills and permits enemies with an explicitly empty skill list', async () => {
        const result = await fetchBosses([{ name: 'Event', enemy_info: enemyInfo() }]);
        equal(result.stages[0].rounds[0].enemies[0].skills[0].description, 'Dodges attacks');
        const noSkills = await fetchBosses([{ enemy_info: enemyInfo([]) }]);
        deepStrictEqual(noSkills.stages[0].rounds[0].enemies[0].skills, []);
    });
});

describe('Dokkan Info stage metadata (offline)', () => {
    it('decodes directory entities and rejects malformed, empty and duplicate directories', () => {
        equal(directory()[0].name, 'A & B');
        for (const source of ['unavailable', '<events v-bind:eventjson="[]"></events>',
            `<events v-bind:eventjson='[{"id":7,"name":"A"},{"id":7,"name":"B"}]'></events>`,
            `<events v-bind:eventjson='[{"id":0,"name":"A"}]'></events>`]) {
            throws(() => parseEventDirectory(doc(source)));
        }
    });
    it('associates visible numbers with inline titles, gaps and every unique difficulty destination', () => {
        const stages = parseEventStages(doc(fixture), 701);
        deepStrictEqual(stages.map(s => [s.number, s.title, s.destinations.map(d => d.id)]), [
            [7, 'Goku & Vegeta Stage 2', [7010073, 7010075]], [9, 'Next', [7010095]],
        ]);
        equal(stages[0].destinations[0].url, 'https://dokkaninfo.com/events/challenge/701/7010073');
    });
    it('fails closed on missing headings, destinations, empty or conflicting titles and reused IDs', () => {
        for (const html of ['Service unavailable', '<a href="/events/challenge/701/1">orphan</a>',
            '<div>Level 1: Missing link</div>', '<div>Level 1:</div><a href="/events/challenge/701/1">x</a>',
            '<div>Level 1: A</div><div>Level 1: B</div><a href="/events/challenge/701/1">x</a>',
            '<div>Level 1: A</div><a href="/events/challenge/701/1">x</a><div>Level 2: B</div><a href="/events/challenge/701/1">x</a>',
            fixture + '<div>Level 10: Missing</div>',
            '<div>Level 1: A</div><a href="/events/challenge/701/1">x</a><div>Level X: broken</div><a href="/events/challenge/701/2">x</a>',
            fixture + '<section><a href="/events/challenge/701/7010105">missing heading in next section</a></section>']) {
            throws(() => parseEventStages(doc(html), 701));
        }
    });
    it('retains all difficulty IDs and visible levels for the bosses command', async () => {
        deepStrictEqual(await listEventStages(701, async () => doc(fixture)), [
            { id: 7010073, level: 7, name: 'Goku & Vegeta Stage 2' },
            { id: 7010075, level: 7, name: 'Goku & Vegeta Stage 2' },
            { id: 7010095, level: 9, name: 'Next' },
        ]);
    });
    it('exports an explicit versioned contract and rejects unknown IDs or partial acquisition', async () => {
        const result = await exportStageMetadata([701], async () => directory(), async () => doc(fixture));
        deepStrictEqual(Object.keys(result), ['schemaVersion', 'events']);
        equal(result.schemaVersion, 1);
        deepStrictEqual(result.events[0], { id: 701, title: 'A & B', sourceUrl: 'https://dokkaninfo.com/events/challenge/701', stages: parseEventStages(doc(fixture), 701) });
        await rejects(exportStageMetadata([999], async () => directory(), async () => doc(fixture)));
        await rejects(exportStageMetadata(undefined, async () => [...directory(), {...directory()[0], id: 702, url: 'second'}], async url => {
            if (url === 'second') throw new Error('network failure');
            return doc(fixture);
        }), /network failure/);
        await rejects(exportStageMetadata([701], async () => directory(), async () => doc('unavailable')));
    });
});
