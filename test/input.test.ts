import { describe, expect, it } from 'vitest';

import { DEFAULT_CATEGORY_URLS, normalizeInput } from '../src/input.js';

describe('normalizeInput', () => {
    it('normalizes Aime tracing and operational defaults', () => {
        const input = normalizeInput({ campaignId: 'cmp_1', shardId: 'shd_1', searchQueries: [' kahve makinesi ', 'kahve makinesi'] });
        expect(input.campaignId).toBe('cmp_1');
        expect(input.shardId).toBe('shd_1');
        expect(input.searchQueries).toEqual(['kahve makinesi']);
        expect(input.maxSellers).toBe(10);
        expect(input.minProductCount).toBe(0);
        expect(input.requireSellerProfile).toBe(true);
        expect(input.contactEnrichment).toBe(false);
        expect(input.maxContactEnrichmentLeads).toBe(5);
        expect(input.minContactConfidence).toBe(70);
        expect(input.startPage).toBeNull();
        expect(input.resumeFromCheckpoint).toBe(true);
        expect(input.dedupeMode).toBe('new_only');
    });

    it('accepts request-list URL objects', () => {
        const input = normalizeInput({ startUrls: [{ url: 'https://www.hepsiburada.com/magaza/viratech?tab=profile' }] });
        expect(input.startUrls).toEqual(['https://www.hepsiburada.com/magaza/viratech?tab=profile']);
    });

    it('starts the full crawl from Electronics when no discovery source is supplied', () => {
        const input = normalizeInput({});
        expect(input.searchQueries).toEqual([]);
        expect(input.startUrls).toEqual(DEFAULT_CATEGORY_URLS);
    });

    it('accepts an explicit page shard', () => {
        const input = normalizeInput({ startPage: 21, maxPagesPerSource: 10, resumeFromCheckpoint: false });
        expect(input.startPage).toBe(21);
        expect(input.maxPagesPerSource).toBe(10);
        expect(input.resumeFromCheckpoint).toBe(false);
    });

    it('rejects non-Hepsiburada URLs and invalid IDs', () => {
        expect(() => normalizeInput({ startUrls: ['https://example.com/'], campaignId: 'bad id' })).toThrow();
        expect(() => normalizeInput({ searchQueries: ['phone'], campaignId: 'bad id' })).toThrow('campaignId is invalid');
    });
});
