import { Actor, log } from 'apify';

import { ApifyResidentialFetcher, DirectPageFetcher, FallbackHtmlFetcher, type HtmlFetcher } from './apify-proxy.js';
import { CATEGORY_MANIFEST_VERSION, FULL_PLATFORM_CATEGORIES, selectPendingCategories, validateCategoryManifest } from './categories.js';
import { CrawlState, type PageProgress } from './crawl-state.js';
import { applyDedupe } from './dedupe.js';
import { normalizeInput } from './input.js';
import { extractProductUrls, isProductUrl, isStoreUrl, parseMerchantProfile, parseProductPage } from './parser.js';
import type { ActorInput, MerchantCandidate, MerchantProfile, ProductEvidence, RunSummary, SellerLead, SourceCursor, UnlockerUsage } from './types.js';
import { BrightDataUnlocker } from './unlocker.js';
import { enrichPublicBusinessContacts } from './contact-enrichment.js';

await Actor.init();

const input = normalizeInput(await Actor.getInput<ActorInput>());
const runId = process.env.APIFY_ACTOR_RUN_ID?.trim() || process.env.ACTOR_RUN_ID?.trim() || 'local';
const datasetId = process.env.APIFY_DEFAULT_DATASET_ID?.trim() || process.env.ACTOR_DEFAULT_DATASET_ID?.trim() || 'default';
const brightDataApiKey = process.env.BRIGHT_DATA_API_KEY?.trim();
const brightDataUnlocker = brightDataApiKey ? new BrightDataUnlocker({
    apiKey: brightDataApiKey,
    zone: process.env.BRIGHT_DATA_ZONE?.trim() || 'ebay_live_unlocker',
    timeoutMillis: input.navigationTimeoutSecs * 1_000,
    maxAttempts: input.maxRequestRetries + 1,
}) : null;
if (input.accessMode === 'bright_data' && !brightDataUnlocker) throw new Error('BRIGHT_DATA_API_KEY is required in bright_data mode');

const needsApifyProxy = input.accessMode === 'apify_proxy' || input.accessMode === 'auto';
const proxyConfiguration = needsApifyProxy ? await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    countryCode: input.apifyProxyCountry,
}) : undefined;
if (input.accessMode === 'apify_proxy' && !proxyConfiguration) throw new Error('Apify Residential Proxy is unavailable for this account');
const apifyProxyFetcher = proxyConfiguration
    ? new ApifyResidentialFetcher(proxyConfiguration, input.navigationTimeoutSecs * 1_000, input.maxRequestRetries + 1)
    : null;
const directFetcher = new DirectPageFetcher(Math.min(15_000, input.navigationTimeoutSecs * 1_000));
const automaticFetchers: HtmlFetcher[] = [directFetcher];
if (apifyProxyFetcher) automaticFetchers.push(apifyProxyFetcher);
if (brightDataUnlocker) automaticFetchers.push(brightDataUnlocker);
const pageFetcher: HtmlFetcher = input.accessMode === 'direct'
    ? directFetcher
    : input.accessMode === 'apify_proxy'
        ? apifyProxyFetcher as ApifyResidentialFetcher
        : input.accessMode === 'bright_data'
            ? brightDataUnlocker as BrightDataUnlocker
            : new FallbackHtmlFetcher(automaticFetchers);
const dedupeStore = await Actor.openKeyValueStore(input.dedupeStoreName);
const crawlState = new CrawlState(dedupeStore, 'sayfa');
const startedAt = new Date().toISOString();
const failedSources: Array<{ source: string; error: string }> = [];
const productUrls = new Map<string, Set<string>>();
const candidates = new Map<string, MerchantCandidate>();
const knownProfiles = new Map<string, MerchantProfile>();
const discoveredSellerIds = new Set<string>();
const sourceCursors = new Map<string, SourceCursor>();

let productDetailAttempted = 0;
let productDetailSucceeded = 0;
let sellerProfileAttempted = 0;
let sellerProfileSucceeded = 0;
let sellerProfileFailed = 0;
let qualifiedLeadCount = 0;
let emittedLeadCount = 0;
let duplicateSuppressedCount = 0;
let contactEnrichmentAttempted = 0;
let contactEnrichmentVerified = 0;
let contactEmailsFound = 0;
let contactPhonesFound = 0;
let pageAttempted = 0;
let pageCompleted = 0;
let pageSkipped = 0;
let pageResumed = 0;
let productCacheHits = 0;
let sellerProfileCacheHits = 0;
let productDetailFetches = 0;
let sellerCandidateProcessed = 0;
let categoriesProcessedThisRun = 0;
let currentCategory: string | null = null;

const discoverySources: Array<{ url: string; label: string }> = [];
const directProductUrls: Array<{ url: string; label: string }> = [];

function combinedUnlockerUsage(...usages: UnlockerUsage[]): UnlockerUsage {
    return {
        logical_requests: usages.reduce((sum, value) => sum + value.logical_requests, 0),
        request_attempts: usages.reduce((sum, value) => sum + value.request_attempts, 0),
        successful_requests: usages.reduce((sum, value) => sum + value.successful_requests, 0),
        failed_attempts: usages.reduce((sum, value) => sum + value.failed_attempts, 0),
        static_requests: usages.reduce((sum, value) => sum + value.static_requests, 0),
        rendered_requests: usages.reduce((sum, value) => sum + value.rendered_requests, 0),
        estimated_cost_usd: Number(usages.reduce((sum, value) => sum + value.estimated_cost_usd, 0).toFixed(6)),
    };
}

function paginatedUrl(value: string, page: number): string {
    const url = new URL(value);
    if (page > 1) url.searchParams.set('sayfa', String(page));
    return url.toString();
}

if (input.crawlScope === 'full_platform') {
    validateCategoryManifest(FULL_PLATFORM_CATEGORIES);
    for (const category of FULL_PLATFORM_CATEGORIES) discoverySources.push({ url: category.url, label: category.name });
} else {
    for (const query of input.searchQueries) {
        const base = `https://www.hepsiburada.com/ara?q=${encodeURIComponent(query)}`;
        discoverySources.push({ url: base, label: query });
    }
    for (const startUrl of input.startUrls) {
        if (isProductUrl(startUrl)) {
            directProductUrls.push({ url: startUrl, label: startUrl });
            continue;
        }
        discoverySources.push({ url: startUrl, label: startUrl });
    }
}

function summary(status: RunSummary['status']): RunSummary {
    const cursors = [...sourceCursors.values()];
    const completedCategoryCount = cursors.filter((cursor) => cursor.exhausted).length;
    return {
        status,
        schema_version: '1.0',
        campaign_id: input.campaignId,
        shard_id: input.shardId,
        run_id: runId,
        dataset_id: datasetId,
        scanned_count: sellerProfileAttempted,
        qualified_count: emittedLeadCount,
        next_cursor: cursors.length ? { version: 1, sources: cursors } : null,
        has_more: cursors.some((cursor) => !cursor.exhausted),
        crawl_scope: input.crawlScope,
        category_manifest_version: input.crawlScope === 'full_platform' ? CATEGORY_MANIFEST_VERSION : null,
        total_category_count: discoverySources.length,
        completed_category_count: completedCategoryCount,
        remaining_category_count: discoverySources.length - completedCategoryCount,
        categories_processed_this_run: categoriesProcessedThisRun,
        current_category: currentCategory,
        start_page: input.startPage,
        resume_from_checkpoint: input.resumeFromCheckpoint,
        page_attempted: pageAttempted,
        page_completed: pageCompleted,
        page_skipped: pageSkipped,
        page_resumed: pageResumed,
        product_cache_hits: productCacheHits,
        seller_profile_cache_hits: sellerProfileCacheHits,
        search_queries: input.searchQueries,
        start_urls: input.startUrls,
        discovery_source_count: discoverySources.length,
        discovered_product_count: productUrls.size,
        discovered_seller_count: discoveredSellerIds.size,
        product_detail_attempted: productDetailAttempted,
        product_detail_succeeded: productDetailSucceeded,
        seller_profile_attempted: sellerProfileAttempted,
        seller_profile_succeeded: sellerProfileSucceeded,
        seller_profile_failed: sellerProfileFailed,
        qualified_lead_count: qualifiedLeadCount,
        emitted_lead_count: emittedLeadCount,
        duplicate_suppressed_count: duplicateSuppressedCount,
        contact_enrichment_attempted: contactEnrichmentAttempted,
        contact_enrichment_verified: contactEnrichmentVerified,
        contact_emails_found: contactEmailsFound,
        contact_phones_found: contactPhonesFound,
        failed_sources: failedSources,
        access_mode: input.accessMode,
        apify_proxy_country: input.apifyProxyCountry,
        apify_proxy_usage: apifyProxyFetcher?.usage ?? {
            logical_requests: 0, request_attempts: 0, successful_requests: 0,
            failed_attempts: 0, response_bytes: 0, response_gigabytes: 0,
        },
        unlocker_configured: brightDataUnlocker !== null,
        unlocker_usage: combinedUnlockerUsage(...(brightDataUnlocker ? [brightDataUnlocker.usage] : [])),
        started_at: startedAt,
        ...(status === 'RUNNING' ? {} : { finished_at: new Date().toISOString() }),
    };
}

async function initializeSourceCursors(): Promise<void> {
    for (const source of discoverySources) {
        const startPage = await crawlState.resolveStartPage(source.url, input.startPage, input.resumeFromCheckpoint);
        const cursor = await crawlState.cursor(source.url, source.label, startPage);
        sourceCursors.set(cursor.source_id, cursor);
    }
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
    discoveredSellerIds.add(evidence.seller_id);
    const existing = candidates.get(evidence.seller_id);
    if (existing) {
        if (!existing.evidences.some((item) => item.product_url === evidence.product_url)) existing.evidences.push(evidence);
        for (const label of sourceLabels) existing.source_queries.add(label);
        return;
    }
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
    discoveredSellerIds.add(profile.seller_id);
    knownProfiles.set(profile.seller_id, profile);
    if (candidates.has(profile.seller_id)) return;
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
    if (input.minSellerRating > 0 && (lead.seller_rating ?? -1) < input.minSellerRating) reasons.push('seller_rating_below_minimum');
    if (input.minFollowerCount > 0 && (lead.follower_count ?? -1) < input.minFollowerCount) reasons.push('follower_count_below_minimum');
    if (input.minProductCount > 0 && (lead.product_count ?? -1) < input.minProductCount) reasons.push('product_count_below_minimum');
    if (input.minSellerReviewCount > 0 && (lead.seller_review_count ?? -1) < input.minSellerReviewCount) reasons.push('seller_review_count_below_minimum');
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
        official_website: null,
        public_business_emails: profile?.registered_email ? [profile.registered_email] : [],
        public_business_phones: [],
        whatsapp_urls: [],
        social_urls: [],
        contact_source_urls: [],
        contact_confidence: profile?.registered_email ? 100 : 0,
        contact_status: profile?.registered_email ? 'platform_only' : 'not_requested',
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

async function loadProductEvidence(url: string): Promise<ProductEvidence[] | null> {
    const cached = await crawlState.getProduct<ProductEvidence[]>(url);
    if (cached) {
        productCacheHits += 1;
        return cached;
    }
    if (productDetailFetches >= input.maxProductDetails) return null;
    productDetailFetches += 1;
    productDetailAttempted += 1;
    try {
        const html = await pageFetcher.fetchHtml(url, false);
        const evidences = parseProductPage(html, url, input.maxOtherSellersPerProduct);
        if (evidences.length === 0) throw new Error('No product seller state found');
        productDetailSucceeded += 1;
        await crawlState.setProduct(url, evidences);
        return evidences;
    } catch (error) {
        failedSources.push({ source: url, error: String(error) });
        log.warning('Product detail failed', { url, error: String(error) });
        return null;
    }
}

async function loadSellerProfile(candidate: MerchantCandidate): Promise<MerchantProfile | null> {
    const known = knownProfiles.get(candidate.seller_id);
    if (known) return known;
    const cached = await crawlState.getProfile<MerchantProfile>(candidate.seller_id);
    if (cached) {
        sellerProfileCacheHits += 1;
        return cached;
    }
    sellerProfileAttempted += 1;
    try {
        const html = await pageFetcher.fetchHtml(candidate.seller_profile_url, false);
        const profile = parseMerchantProfile(html);
        if (!profile) throw new Error('No merchant profile state found');
        sellerProfileSucceeded += 1;
        await crawlState.setProfile(candidate.seller_id, profile);
        return profile;
    } catch (error) {
        sellerProfileFailed += 1;
        failedSources.push({ source: candidate.seller_profile_url, error: String(error) });
        return null;
    }
}

async function processCandidate(candidate: MerchantCandidate, profile: MerchantProfile | null, progress: PageProgress): Promise<boolean> {
    if (input.requireSellerProfile && !profile) return false;
    let lead = buildLead(candidate, profile);
    const qualification = qualifies(lead);
    if (qualification.qualified) {
        qualifiedLeadCount += 1;
        lead.qualification_reasons = [
            `seller_rating>=${input.minSellerRating}`,
            `follower_count>=${input.minFollowerCount}`,
            `product_count>=${input.minProductCount}`,
            `seller_review_count>=${input.minSellerReviewCount}`,
        ];
        if (input.contactEnrichment && contactEnrichmentAttempted < input.maxContactEnrichmentLeads) {
            contactEnrichmentAttempted += 1;
            try {
                const contact = await enrichPublicBusinessContacts(lead, pageFetcher, {
                    maxCandidates: input.maxWebsiteCandidates,
                    minimumConfidence: input.minContactConfidence,
                });
                lead = { ...lead, ...contact };
                if (contact.contact_status === 'verified') contactEnrichmentVerified += 1;
                contactEmailsFound += contact.public_business_emails.length;
                contactPhonesFound += contact.public_business_phones.length;
            } catch (error) {
                log.warning('Public business contact enrichment failed', { sellerId: lead.seller_id, error: String(error) });
                lead.contact_status = lead.public_business_emails.length ? 'platform_only' : 'error';
            }
        }
        const dedupe = await applyDedupe(dedupeStore, lead, input.dedupeMode);
        if (dedupe.emit) {
            await Actor.pushData(dedupe.lead);
            emittedLeadCount += 1;
        } else {
            duplicateSuppressedCount += 1;
        }
    }
    await crawlState.markSellerProcessed(progress, candidate.seller_id);
    await checkpoint();
    return true;
}

async function processSourcePage(source: { url: string; label: string }, page: number): Promise<boolean> {
    const pageUrl = paginatedUrl(source.url, page);
    let progress = await crawlState.getPage(source.url, page);
    if (progress?.status === 'completed') {
        pageSkipped += 1;
        sourceCursors.set(progress.source_id, await crawlState.cursor(source.url, source.label, page + 1));
        return true;
    }

    candidates.clear();
    knownProfiles.clear();

    if (progress) {
        pageResumed += 1;
    } else {
        pageAttempted += 1;
        try {
            const html = await pageFetcher.fetchHtml(pageUrl, false);
            const discovered = extractProductUrls(html, pageUrl).slice(0, input.maxProductsPerSource);
            const repeatedListing = await crawlState.hasSeenListing(source.url, discovered);
            progress = await crawlState.beginPage(source.url, source.label, page, discovered);
            if (repeatedListing) {
                await crawlState.completePage(progress, true);
                pageCompleted += 1;
                sourceCursors.set(progress.source_id, await crawlState.cursor(source.url, source.label, page));
                log.info('Repeated listing detected; category marked exhausted', { category: source.label, page });
                return true;
            }
            await crawlState.rememberListing(source.url, page, discovered);
            if (isStoreUrl(source.url)) {
                const profile = parseMerchantProfile(html);
                if (profile) {
                    addProfileOnlyCandidate(profile, source.label);
                    await crawlState.setProfile(profile.seller_id, profile);
                }
            }
        } catch (error) {
            failedSources.push({ source: pageUrl, error: String(error) });
            log.warning('Discovery source failed', { url: pageUrl, error: String(error) });
            const cursor = await crawlState.cursor(source.url, source.label, page);
            sourceCursors.set(cursor.source_id, cursor);
            return false;
        }
    }

    if (progress.product_urls.length === 0 && candidates.size === 0) {
        await crawlState.completePage(progress, true);
        pageCompleted += 1;
        sourceCursors.set(progress.source_id, await crawlState.cursor(source.url, source.label, page));
        return true;
    }

    let pageSucceeded = true;
    const labels = new Set([source.label]);
    const productResults = await mapConcurrent(progress.product_urls, input.maxConcurrency, async (url) => {
        productUrls.set(url, labels);
        return { url, evidences: await loadProductEvidence(url) };
    });
    for (const { evidences } of productResults) {
        if (!evidences) {
            pageSucceeded = false;
            continue;
        }
        for (const evidence of evidences) addCandidate(evidence, labels);
    }
    await checkpoint();

    const processed = new Set(progress.processed_seller_ids);
    const pendingCandidates = [...candidates.values()].filter((candidate) => !processed.has(candidate.seller_id));
    let offset = 0;
    while (offset < pendingCandidates.length) {
        if (sellerCandidateProcessed >= input.maxSellerCandidates || emittedLeadCount >= input.maxSellers) {
            pageSucceeded = false;
            break;
        }
        const remainingCapacity = input.maxSellerCandidates - sellerCandidateProcessed;
        const remainingOutputCapacity = input.maxSellers - emittedLeadCount;
        const batch = pendingCandidates.slice(offset, offset + Math.min(input.maxProfileConcurrency, remainingCapacity, remainingOutputCapacity));
        offset += batch.length;
        sellerCandidateProcessed += batch.length;
        const results = await mapConcurrent(batch, input.maxProfileConcurrency, async (candidate) => ({
            candidate,
            profile: await loadSellerProfile(candidate),
        }));
        for (const { candidate, profile } of results) {
            if (!await processCandidate(candidate, profile, progress)) pageSucceeded = false;
        }
    }

    const processedAfter = new Set(progress.processed_seller_ids);
    if ([...candidates.keys()].some((sellerId) => !processedAfter.has(sellerId))) pageSucceeded = false;
    if (pageSucceeded) {
        await crawlState.completePage(progress, false);
        pageCompleted += 1;
    }
    sourceCursors.set(progress.source_id, await crawlState.cursor(source.url, source.label, pageSucceeded ? page + 1 : page));
    return pageSucceeded;
}

await initializeSourceCursors();
await Actor.setValue('OUTPUT', summary('RUNNING'));
log.info('Hepsiburada seller discovery started', {
    campaignId: input.campaignId,
    shardId: input.shardId,
    runId,
    datasetId,
    discoverySources: discoverySources.length,
});

try {
    const scheduledSources = input.crawlScope === 'full_platform'
        ? selectPendingCategories(
            discoverySources,
            new Set([...sourceCursors.values()].filter((cursor) => cursor.exhausted).map((cursor) => cursor.source_url)),
            input.maxCategoriesPerRun,
        )
        : discoverySources;
    for (const source of scheduledSources) {
        if (emittedLeadCount >= input.maxSellers) break;
        currentCategory = source.label;
        categoriesProcessedThisRun += 1;
        const startPage = await crawlState.resolveStartPage(source.url, input.startPage, input.resumeFromCheckpoint);
        for (let page = startPage; page < startPage + input.maxPagesPerSource; page += 1) {
            if (emittedLeadCount >= input.maxSellers) break;
            if (!await processSourcePage(source, page)) break;
            const cursor = await crawlState.cursor(source.url, source.label, page + 1);
            if (cursor.exhausted) break;
        }
        if (emittedLeadCount >= input.maxSellers
            || productDetailFetches >= input.maxProductDetails
            || sellerCandidateProcessed >= input.maxSellerCandidates) break;
    }

    for (const direct of directProductUrls) {
        if (emittedLeadCount >= input.maxSellers) break;
        const synthetic = await crawlState.getPage(direct.url, 1)
            ?? await crawlState.beginPage(direct.url, direct.label, 1, [direct.url]);
        if (synthetic.status !== 'completed') {
            await processSourcePage(direct, 1);
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
