import { describe, expect, it } from 'vitest';

import { CrawlState } from '../src/crawl-state.js';

const memoryStore = () => {
    const values = new Map<string, unknown>();
    return {
        values,
        store: {
            getValue: async <T>(key: string) => (values.get(key) as T | undefined) ?? null,
            setValue: async (key: string, value: unknown) => { values.set(key, value); },
        },
    };
};

describe('CrawlState', () => {
    it('continues page 1 at page 2 and skips a completed page without fetching it again', async () => {
        const { store } = memoryStore();
        const state = new CrawlState(store, 'sayfa');
        const source = 'https://www.hepsiburada.com/bilgisayar-sistemleri-ve-ekipmanlari-c-2147483646';
        expect(await state.resolveStartPage(source, null, true)).toBe(1);
        const page = await state.beginPage(source, 'Electronics', 1, ['https://www.hepsiburada.com/a-p-HBC1']);
        await state.markSellerProcessed(page, 'seller-1');
        await state.completePage(page, false);

        expect(await state.resolveStartPage(source, null, true)).toBe(2);
        expect((await state.cursor(source, 'Electronics', 1)).next_page).toBe(2);
        let listingRequests = 0;
        if ((await state.getPage(source, 1))?.status !== 'completed') listingRequests += 1;
        expect(listingRequests).toBe(0);
    });

    it('retains partial page progress and reuses product/profile caches', async () => {
        const { store } = memoryStore();
        const state = new CrawlState(store, 'sayfa');
        const source = 'https://www.hepsiburada.com/bilgisayar-sistemleri-ve-ekipmanlari-c-2147483646';
        const product = 'https://www.hepsiburada.com/a-p-HBC1';
        const page = await state.beginPage(source, 'Electronics', 1, [product]);
        await state.markSellerProcessed(page, 'seller-1');
        await state.setProduct(product, [{ seller_id: 'seller-1' }]);
        await state.setProfile('seller-1', { seller_id: 'seller-1' });

        expect(await state.resolveStartPage(source, null, true)).toBe(1);
        expect((await state.getPage(source, 1))?.processed_seller_ids).toEqual(['seller-1']);
        expect(await state.getProduct(product)).toEqual([{ seller_id: 'seller-1' }]);
        expect(await state.getProfile('seller-1')).toEqual({ seller_id: 'seller-1' });
    });
});
