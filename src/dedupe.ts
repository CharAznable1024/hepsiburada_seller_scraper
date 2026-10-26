import { createHash } from 'node:crypto';

import type { DedupeMode, SellerLead } from './types.js';

interface StoreLike {
    getValue<T>(key: string): Promise<T | null>;
    setValue(key: string, value: unknown): Promise<void>;
}

interface SellerState {
    fingerprint: string;
    first_seen_at: string;
    last_seen_at: string;
    times_seen: number;
}

const fingerprint = (lead: SellerLead): string => createHash('sha256').update(JSON.stringify({
    seller_name: lead.seller_name,
    seller_type: lead.seller_type,
    seller_rating: lead.seller_rating,
    seller_review_count: lead.seller_review_count,
    follower_count: lead.follower_count,
    product_count: lead.product_count,
    shipping_city: lead.shipping_city,
    average_dispatch_time: lead.average_dispatch_time,
    customer_service_response_time: lead.customer_service_response_time,
    time_on_hepsiburada: lead.time_on_hepsiburada,
    trade_name: lead.trade_name,
    tax_number: lead.tax_number,
    mersis_number: lead.mersis_number,
    registered_address: lead.registered_address,
})).digest('hex');

export async function applyDedupe(
    store: StoreLike,
    lead: SellerLead,
    mode: DedupeMode,
): Promise<{ emit: boolean; lead: SellerLead }> {
    const key = `SELLER_${lead.seller_id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const previous = await store.getValue<SellerState>(key);
    const now = lead.scraped_at;
    const nextFingerprint = fingerprint(lead);
    const unchanged = previous?.fingerprint === nextFingerprint;
    const status: SellerLead['dedupe_status'] = mode === 'all' ? 'all' : !previous ? 'new' : unchanged ? 'unchanged' : 'updated';
    const enriched = {
        ...lead,
        dedupe_status: status,
        first_seen_at: previous?.first_seen_at ?? now,
        last_seen_at: now,
        times_seen: (previous?.times_seen ?? 0) + 1,
    };
    await store.setValue(key, {
        fingerprint: nextFingerprint,
        first_seen_at: enriched.first_seen_at,
        last_seen_at: now,
        times_seen: enriched.times_seen,
    } satisfies SellerState);
    return {
        emit: mode === 'all' || !previous || (mode === 'new_and_updated' && !unchanged),
        lead: enriched,
    };
}
