import { describe, expect, it } from 'vitest';

import { DEFAULT_SEARCH_QUERIES, normalizeInput } from '../src/input.js';

describe('normalizeInput', () => {
    it('normalizes Aime tracing and operational defaults', () => {
        const input = normalizeInput({ campaignId: 'cmp_1', shardId: 'shd_1', searchQueries: [' kahve makinesi ', 'kahve makinesi'] });
        expect(input.campaignId).toBe('cmp_1');
        expect(input.shardId).toBe('shd_1');
        expect(input.searchQueries).toEqual(['kahve makinesi']);
        expect(input.maxSellers).toBe(10);
        expect(input.requireSellerProfile).toBe(true);
        expect(input.contactEnrichment).toBe(true);
        expect(input.maxContactEnrichmentLeads).toBe(5);
        expect(input.minContactConfidence).toBe(70);
    });

    it('accepts request-list URL objects', () => {
        const input = normalizeInput({ startUrls: [{ url: 'https://www.hepsiburada.com/magaza/viratech?tab=profile' }] });
        expect(input.startUrls).toEqual(['https://www.hepsiburada.com/magaza/viratech?tab=profile']);
    });

    it('uses balanced default categories when no discovery source is supplied', () => {
        const input = normalizeInput({});
        expect(input.searchQueries).toEqual(DEFAULT_SEARCH_QUERIES);
        expect(input.startUrls).toEqual([]);
    });

    it('rejects non-Hepsiburada URLs and invalid IDs', () => {
        expect(() => normalizeInput({ startUrls: ['https://example.com/'], campaignId: 'bad id' })).toThrow();
        expect(() => normalizeInput({ searchQueries: ['phone'], campaignId: 'bad id' })).toThrow('campaignId is invalid');
    });
});
