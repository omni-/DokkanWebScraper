import { equal } from 'assert';
import { describe, it } from 'mocha';
import { listBannerUrl } from './dokkaninfo';

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
