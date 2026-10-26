import { describe, expect, it } from 'vitest';

import { applyDedupe } from '../src/dedupe.js';
import type { SellerLead } from '../src/types.js';

const lead = (): SellerLead => ({
    record_type: 'merchant_lead', schema_version: '1.0', campaign_id: null, shard_id: null, run_id: 'run', seller_id: 'seller-1', seller_name: 'Store', seller_profile_url: 'https://example.com', seller_type: null,
    seller_rating: 9, seller_review_count: 10, follower_count: 20, product_count: 30, shipping_city: 'ISTANBUL', seller_country: 'TÜRKİYE', seller_country_code: 'TR', average_dispatch_time: '1 gün', customer_service_response_time: '0-12 saat', time_on_hepsiburada: '1 yıl', is_women_entrepreneur: false,
    trade_name: 'Store Ltd', registered_email: null, tax_number: '123', mersis_number: '456', registered_address: 'Istanbul', contact_disclosure: null, brands: ['A'], categories: ['B'], matched_product_count: 1, sample_product_urls: [], source_queries: [],
    product_id: null, sku: null, product_url: null, product_title: null, product_rating: null, product_review_count: null, price: null, price_currency: null, free_shipping: null, promotion_info: [], product_description: null, product_description_source: null, installment_terms: [],
    lead_score: 70, qualification: 'QUALIFIED', qualification_reasons: [], dedupe_status: 'new', first_seen_at: '2026-01-01T00:00:00.000Z', last_seen_at: '2026-01-01T00:00:00.000Z', times_seen: 1, scraped_at: '2026-01-01T00:00:00.000Z',
});

describe('applyDedupe', () => {
    it('suppresses unchanged sellers in new_and_updated mode', async () => {
        const values = new Map<string, unknown>();
        const store = { getValue: async <T>(key: string) => (values.get(key) as T | undefined) ?? null, setValue: async (key: string, value: unknown) => { values.set(key, value); } };
        expect((await applyDedupe(store, lead(), 'new_and_updated')).emit).toBe(true);
        const second = await applyDedupe(store, { ...lead(), scraped_at: '2026-01-02T00:00:00.000Z' }, 'new_and_updated');
        expect(second.emit).toBe(false);
        expect(second.lead.dedupe_status).toBe('unchanged');
        expect(second.lead.times_seen).toBe(2);
    });
});
