import { equal } from 'assert';
import { describe, it } from 'mocha';
import { cleanPassiveEffect, signArrowValues, toReleaseDate } from './dokkanstatsScraper';

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

describe('DokkanStats passive arrows', function () {
    it('turns up and down arrows after a value into plus and minus signs', function () {
        const value = "ATK & DEF 200%{passiveImg:up_g} and Extreme Class enemies' DEF 70%{passiveImg:down_y}";

        const result = signArrowValues(value);

        equal(result, "ATK & DEF +200% and Extreme Class enemies' DEF -70%");
    });

    it('leaves values that already have a sign and other icons alone', function () {
        const value = '{passiveImg:once}Ki +3{passiveImg:up_g} and ATK 100%';

        const result = signArrowValues(value);

        equal(result, '{passiveImg:once}Ki +3{passiveImg:up_g} and ATK 100%');
    });

    it('keeps the once and forever icons of a passive effect and drops the rest', function () {
        const value = '{passiveImg:once}{passiveImg:forever}ATK & DEF 250%{passiveImg:up_g} <b>and</b> {passiveImg:other}Ki +2';

        const result = cleanPassiveEffect(value);

        equal(result, '{passiveImg:once}{passiveImg:forever}ATK & DEF +250% and Ki +2');
    });
});
