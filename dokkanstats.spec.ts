import { equal } from 'assert';
import { describe, it } from 'mocha';
import { toReleaseDate } from './dokkanstatsScraper';

describe('DokkanStats release dates', function () {
    it('keeps the UTC date of a DokkanStats timestamp', function () {
        const value = '2025-11-13 01:00:00';

        const result = toReleaseDate(value);

        equal(result, '2025-11-13');
    });

    it('returns undefined for missing or unreadable timestamps', function () {
        const values = [undefined, null, '', 'soon'];

        const results = values.map(value => toReleaseDate(value));

        results.forEach(result => equal(result, undefined));
    });
});
