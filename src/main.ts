import { Actor, log } from 'apify';

import { applyDedupe } from './dedupe.js';
import { normalizeInput } from './input.js';
import { extractProductUrls, isProductUrl, isStoreUrl, parseMerchantProfile, parseProductPage } from './parser.js';
import type { ActorInput, MerchantCandidate, MerchantProfile, RunSummary, SellerLead } from './types.js';
import { BrightDataUnlocker } from './unlocker.js';

await Actor.init();

const input = normalizeInput(await Actor.getInput<ActorInput>());
const runId = process.env.APIFY_ACTOR_RUN_ID?.trim() || process.env.ACTOR_RUN_ID?.trim() || 'local';
const datasetId = process.env.APIFY_DEFAULT_DATASET_ID?.trim() || process.env.ACTOR_DEFAULT_DATASET_ID?.trim() || 'default';
const brightDataApiKey = process.env.BRIGHT_DATA_API_KEY?.trim();
if (!brightDataApiKey) throw new Error('BRIGHT_DATA_API_KEY is required because Hepsiburada blocks direct cloud access');

const unlocker = new BrightDataUnlocker({
    apiKey: brightDataApiKey,
    zone: process.env.BRIGHT_DATA_ZONE?.trim() || 'ebay_live_unlocker',
    timeoutMillis: input.navigationTimeoutSecs * 1_000,
    maxAttempts: input.maxRequestRetries + 1,
});
const dedupeStore = await Actor.openKeyValueStore(input.dedupeStoreName);
const startedAt = new Date().toISOString();
const failedSources: Array<{ source: string; error: string }> = [];
const productUrls = new Map<string, Set<string>>();
const candidates = new Map<string, MerchantCandidate>();
const knownProfiles = new Map<string, MerchantProfile>();

let productDetailAttempted = 0;
let productDetailSucceeded = 0;
let sellerProfileAttempted = 0;
let sellerProfileSucceeded = 0;
let sellerProfileFailed = 0;
let qualifiedLeadCount = 0;
let emittedLeadCount = 0;
let duplicateSuppressedCount = 0;

const discoverySources: Array<{ url: string; label: string }> = [];

function paginatedUrl(value: string, page: number): string {
    const url = new URL(value);
    if (page > 1) url.searchParams.set('sayfa', String(page));
    return url.toString();
}

for (const query of input.searchQueries) {
    const base = `https://www.hepsiburada.com/ara?q=${encodeURIComponent(query)}`;
    for (let page = 1; page <= input.maxPagesPerSource; page += 1) {
        discoverySources.push({ url: paginatedUrl(base, page), label: query });
    }
}
for (const startUrl of input.startUrls) {
    if (isProductUrl(startUrl)) {
        productUrls.set(startUrl, new Set([startUrl]));
        continue;
    }
    for (let page = 1; page <= input.maxPagesPerSource; page += 1) {
        discoverySources.push({ url: paginatedUrl(startUrl, page), label: startUrl });
    }
}

function summary(status: RunSummary['status']): RunSummary {
    return {
        status,
        schema_version: '1.0',
        campaign_id: input.campaignId,
        shard_id: input.shardId,
        run_id: runId,
        dataset_id: datasetId,
        scanned_count: sellerProfileAttempted,
        qualified_count: emittedLeadCount,
        next_cursor: null,
        has_more: productUrls.size > productDetailAttempted || candidates.size > sellerProfileAttempted,
        search_queries: input.searchQueries,
        start_urls: input.startUrls,
        discovery_source_count: discoverySources.length,
        discovered_product_count: productUrls.size,
        discovered_seller_count: candidates.size,
        product_detail_attempted: productDetailAttempted,
        product_detail_succeeded: productDetailSucceeded,
        seller_profile_attempted: sellerProfileAttempted,
        seller_profile_succeeded: sellerProfileSucceeded,
        seller_profile_failed: sellerProfileFailed,
        qualified_lead_count: qualifiedLeadCount,
        emitted_lead_count: emittedLeadCount,
        duplicate_suppressed_count: duplicateSuppressedCount,
        failed_sources: failedSources,
        unlocker_configured: true,
        unlocker_usage: { ...unlocker.usage },
        started_at: startedAt,
        ...(status === 'RUNNING' ? {} : { finished_at: new Date().toISOString() }),
    };
}

async function checkpoint(): Promise<void> {
    await Actor.setValue('PROGRESS', summary('RUNNING'));
}

Actor.on('aborting', async () => {
    log.warning('Run is aborting; persisting partial progress.');
    await Actor.setValue('OUTPUT', summary('ABORTED'));
});

async function mapConcurrent<T, R>(values: T[], concurrency: number, worker: (value: T, index: number) => Promise<R>): Promise<R[]> {
    const output = new Array<R>(values.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (next < values.length) {
            const index = next;
            next += 1;
            output[index] = await worker(values[index], index);
        }
    });
    await Promise.all(workers);
    return output;
}

function addCandidate(evidence: ReturnType<typeof parseProductPage>[number], sourceLabels: Set<string>): void {
    const existing = candidates.get(evidence.seller_id);
    if (existing) {
        if (!existing.evidences.some((item) => item.product_url === evidence.product_url)) existing.evidences.push(evidence);
        for (const label of sourceLabels) existing.source_queries.add(label);
        return;
    }
    if (candidates.size >= input.maxSellerCandidates) return;
    candidates.set(evidence.seller_id, {
        seller_id: evidence.seller_id,
        seller_name: evidence.seller_name,
        seller_profile_url: evidence.seller_profile_url,
        seller_type: evidence.seller_type,
        seller_rating: evidence.seller_rating,
        seller_rating_count: evidence.seller_rating_count,
        seller_city: evidence.seller_city,
        seller_country: evidence.seller_country,
        seller_country_code: evidence.seller_country_code,
        is_women_entrepreneur: evidence.is_women_entrepreneur,
        evidences: [evidence],
        source_queries: new Set(sourceLabels),
    });
}

function addProfileOnlyCandidate(profile: MerchantProfile, source: string): void {
    knownProfiles.set(profile.seller_id, profile);
    if (candidates.has(profile.seller_id) || candidates.size >= input.maxSellerCandidates) return;
    candidates.set(profile.seller_id, {
        seller_id: profile.seller_id,
        seller_name: profile.seller_name ?? profile.seller_slug,
        seller_profile_url: profile.seller_profile_url,
        seller_type: null,
        seller_rating: profile.seller_rating,
        seller_rating_count: profile.seller_review_count,
        seller_city: profile.shipping_city,
        seller_country: null,
        seller_country_code: null,
        is_women_entrepreneur: profile.is_women_entrepreneur,
        evidences: [],
        source_queries: new Set([source]),
    });
}

function normalized(value: string | null): string {
    return (value ?? '').toLocaleUpperCase('tr-TR').trim();
}

function qualifies(lead: SellerLead): { qualified: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if ((lead.seller_rating ?? -1) < input.minSellerRating) reasons.push('seller_rating_below_minimum');
    if ((lead.follower_count ?? -1) < input.minFollowerCount) reasons.push('follower_count_below_minimum');
    if ((lead.product_count ?? -1) < input.minProductCount) reasons.push('product_count_below_minimum');
    if ((lead.seller_review_count ?? -1) < input.minSellerReviewCount) reasons.push('seller_review_count_below_minimum');
    if (input.sellerCities.length && !input.sellerCities.some((city) => normalized(city) === normalized(lead.shipping_city))) {
        reasons.push('seller_city_not_allowed');
    }
    if (input.sellerTypes.length && !input.sellerTypes.some((type) => normalized(type) === normalized(lead.seller_type))) {
        reasons.push('seller_type_not_allowed');
    }
    return { qualified: reasons.length === 0, reasons };
}

function score(profile: MerchantProfile | null, candidate: MerchantCandidate): number {
    const rating = profile?.seller_rating ?? candidate.seller_rating ?? 0;
    const followers = profile?.follower_count ?? 0;
    const products = profile?.product_count ?? 0;
    const reviews = profile?.seller_review_count ?? candidate.seller_rating_count ?? 0;
    const legalCompleteness = [profile?.trade_name, profile?.tax_number, profile?.mersis_number, profile?.registered_address].filter(Boolean).length;
    return Math.min(100, Math.round(rating * 5 + Math.log10(followers + 1) * 8 + Math.log10(products + 1) * 7 + Math.log10(reviews + 1) * 5 + legalCompleteness * 3));
}

function buildLead(candidate: MerchantCandidate, profile: MerchantProfile | null): SellerLead {
    const primary = candidate.evidences[0] ?? null;
    const scrapedAt = new Date().toISOString();
    return {
        record_type: 'merchant_lead',
        schema_version: '1.0',
        campaign_id: input.campaignId,
        shard_id: input.shardId,
        run_id: runId,
        seller_id: candidate.seller_id,
        seller_name: profile?.seller_name ?? candidate.seller_name,
        seller_profile_url: profile?.seller_profile_url ?? candidate.seller_profile_url,
        seller_type: candidate.seller_type,
        seller_rating: profile?.seller_rating ?? candidate.seller_rating,
        seller_review_count: profile?.seller_review_count ?? candidate.seller_rating_count,
        follower_count: profile?.follower_count ?? null,
        product_count: profile?.product_count ?? null,
        shipping_city: profile?.shipping_city ?? candidate.seller_city,
        seller_country: candidate.seller_country,
        seller_country_code: candidate.seller_country_code,
        average_dispatch_time: profile?.average_dispatch_time ?? null,
        customer_service_response_time: profile?.customer_service_response_time ?? null,
        time_on_hepsiburada: profile?.time_on_hepsiburada ?? null,
        is_women_entrepreneur: profile?.is_women_entrepreneur ?? candidate.is_women_entrepreneur,
        trade_name: profile?.trade_name ?? null,
        registered_email: profile?.registered_email ?? null,
        tax_number: profile?.tax_number ?? null,
        mersis_number: profile?.mersis_number ?? null,
        registered_address: profile?.registered_address ?? null,
        contact_disclosure: profile?.contact_disclosure ?? null,
        brands: [...new Set(candidate.evidences.flatMap((item) => item.brand ?? []))],
        categories: [...new Set(candidate.evidences.flatMap((item) => item.categories))],
        matched_product_count: candidate.evidences.length,
        sample_product_urls: [...new Set(candidate.evidences.map((item) => item.product_url))].slice(0, 5),
        source_queries: [...candidate.source_queries],
        product_id: primary?.product_id ?? null,
        sku: primary?.sku ?? null,
        product_url: primary?.product_url ?? null,
        product_title: primary?.product_title ?? null,
        product_rating: primary?.product_rating ?? null,
        product_review_count: primary?.product_review_count ?? null,
        price: primary?.price ?? null,
        price_currency: primary?.price_currency ?? null,
        free_shipping: primary?.free_shipping ?? null,
        promotion_info: primary?.promotion_info ?? [],
        product_description: primary?.product_description ?? null,
        product_description_source: primary?.product_description_source ?? null,
        installment_terms: primary?.installment_terms ?? [],
        lead_score: score(profile, candidate),
        qualification: 'QUALIFIED',
        qualification_reasons: [],
        dedupe_status: 'new',
        first_seen_at: scrapedAt,
        last_seen_at: scrapedAt,
        times_seen: 1,
        scraped_at: scrapedAt,
    };
}

await Actor.setValue('OUTPUT', summary('RUNNING'));
log.info('Hepsiburada seller discovery started', {
    campaignId: input.campaignId,
    shardId: input.shardId,
    runId,
    datasetId,
    discoverySources: discoverySources.length,
});

try {
    await mapConcurrent(discoverySources, input.maxConcurrency, async (source) => {
        try {
            const html = await unlocker.fetchHtml(source.url, false);
            const discovered = extractProductUrls(html, source.url).slice(0, input.maxProductsPerSource);
            for (const url of discovered) {
                const labels = productUrls.get(url) ?? new Set<string>();
                labels.add(source.label);
                productUrls.set(url, labels);
            }
            if (isStoreUrl(source.url)) {
                const profile = parseMerchantProfile(html);
                if (profile) addProfileOnlyCandidate(profile, source.label);
            }
        } catch (error) {
            failedSources.push({ source: source.url, error: String(error) });
            log.warning('Discovery source failed', { url: source.url, error: String(error) });
        }
    });

    const selectedProducts = [...productUrls.entries()].slice(0, input.maxProductDetails);
    await mapConcurrent(selectedProducts, input.maxConcurrency, async ([url, labels]) => {
        productDetailAttempted += 1;
        try {
            const html = await unlocker.fetchHtml(url, false);
            const evidences = parseProductPage(html, url, input.maxOtherSellersPerProduct);
            if (evidences.length === 0) throw new Error('No product seller state found');
            productDetailSucceeded += 1;
            for (const evidence of evidences) addCandidate(evidence, labels);
        } catch (error) {
            failedSources.push({ source: url, error: String(error) });
            log.warning('Product detail failed', { url, error: String(error) });
        }
    });
    await checkpoint();

    const sellerCandidates = [...candidates.values()].slice(0, input.maxSellerCandidates);
    for (let offset = 0; offset < sellerCandidates.length && emittedLeadCount < input.maxSellers; offset += input.maxProfileConcurrency) {
        const batch = sellerCandidates.slice(offset, offset + input.maxProfileConcurrency);
        const results = await mapConcurrent(batch, input.maxProfileConcurrency, async (candidate) => {
            sellerProfileAttempted += 1;
            const known = knownProfiles.get(candidate.seller_id);
            if (known) {
                sellerProfileSucceeded += 1;
                return { candidate, profile: known };
            }
            try {
                const html = await unlocker.fetchHtml(candidate.seller_profile_url, false);
                const profile = parseMerchantProfile(html);
                if (!profile) throw new Error('No merchant profile state found');
                sellerProfileSucceeded += 1;
                return { candidate, profile };
            } catch (error) {
                sellerProfileFailed += 1;
                failedSources.push({ source: candidate.seller_profile_url, error: String(error) });
                return { candidate, profile: null };
            }
        });

        for (const { candidate, profile } of results) {
            if (emittedLeadCount >= input.maxSellers) break;
            if (input.requireSellerProfile && !profile) continue;
            const lead = buildLead(candidate, profile);
            const qualification = qualifies(lead);
            if (!qualification.qualified) continue;
            qualifiedLeadCount += 1;
            lead.qualification_reasons = [
                `seller_rating>=${input.minSellerRating}`,
                `follower_count>=${input.minFollowerCount}`,
                `product_count>=${input.minProductCount}`,
                `seller_review_count>=${input.minSellerReviewCount}`,
            ];
            const dedupe = await applyDedupe(dedupeStore, lead, input.dedupeMode);
            if (!dedupe.emit) {
                duplicateSuppressedCount += 1;
                continue;
            }
            await Actor.pushData(dedupe.lead);
            emittedLeadCount += 1;
            await checkpoint();
        }
    }

    const output = summary('SUCCEEDED');
    await Actor.setValue('OUTPUT', output);
    log.info('Hepsiburada seller discovery finished', output);
} catch (error) {
    await Actor.setValue('OUTPUT', summary('FAILED'));
    throw error;
} finally {
    await Actor.exit();
}
