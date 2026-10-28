import type { AccessMode, ActorInput, CrawlScope, DedupeMode, Input } from './types.js';

export const DEFAULT_SEARCH_QUERIES: string[] = [];

const identifier = (value: unknown, field: string): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new Error(`${field} must be a string`);
    const resolved = value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(resolved)) throw new Error(`${field} is invalid`);
    return resolved;
};

const strings = (value: unknown, fallback: string[], field: string): string[] => {
    const raw = value === undefined ? fallback : value;
    if (!Array.isArray(raw)) throw new Error(`${field} must be an array`);
    const values = raw.map((item) => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item === 'object' && typeof (item as { url?: unknown }).url === 'string') {
            return String((item as { url: string }).url).trim();
        }
        return '';
    }).filter(Boolean);
    return [...new Set(values)];
};

const integer = (value: unknown, fallback: number, min: number, max: number, field: string): number => {
    const resolved = value === undefined ? fallback : value;
    if (!Number.isInteger(resolved) || Number(resolved) < min || Number(resolved) > max) {
        throw new Error(`${field} must be an integer between ${min} and ${max}`);
    }
    return Number(resolved);
};

const number = (value: unknown, fallback: number, min: number, max: number, field: string): number => {
    const resolved = value === undefined ? fallback : value;
    if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved < min || resolved > max) {
        throw new Error(`${field} must be a number between ${min} and ${max}`);
    }
    return resolved;
};

const boolean = (value: unknown, fallback: boolean, field: string): boolean => {
    const resolved = value === undefined ? fallback : value;
    if (typeof resolved !== 'boolean') throw new Error(`${field} must be a boolean`);
    return resolved;
};

export function normalizeInput(raw: ActorInput | null | undefined): Input {
    const data = raw ?? {};
    const requestedSearchQueries = strings(data.searchQueries, [], 'searchQueries');
    const requestedStartUrls = strings(data.startUrls, [], 'startUrls');
    const hasCustomSources = requestedSearchQueries.length > 0 || requestedStartUrls.length > 0;
    const crawlScope = (data.crawlScope ?? (hasCustomSources ? 'custom' : 'full_platform')) as CrawlScope;
    if (!['full_platform', 'custom'].includes(crawlScope)) throw new Error('crawlScope must be full_platform or custom');
    if (crawlScope === 'full_platform' && hasCustomSources) throw new Error('searchQueries and startUrls must be empty in full_platform mode');
    if (crawlScope === 'custom' && !hasCustomSources) throw new Error('custom crawlScope requires searchQueries or startUrls');
    const accessMode = (data.accessMode ?? 'apify_proxy') as AccessMode;
    if (!['direct', 'apify_proxy', 'bright_data', 'auto'].includes(accessMode)) throw new Error('Invalid accessMode');
    const apifyProxyCountry = data.apifyProxyCountry ?? 'TR';
    if (typeof apifyProxyCountry !== 'string' || !/^[A-Za-z]{2}$/.test(apifyProxyCountry)) {
        throw new Error('apifyProxyCountry must be a two-letter country code');
    }
    const startUrls = requestedStartUrls;
    const searchQueries = requestedSearchQueries;
    for (const value of startUrls) {
        const url = new URL(value);
        if (url.protocol !== 'https:' || !/(^|\.)hepsiburada\.com$/i.test(url.hostname)) {
            throw new Error('startUrls must contain public Hepsiburada HTTPS URLs');
        }
    }
    const dedupeMode = (data.dedupeMode ?? 'new_only') as DedupeMode;
    if (!['all', 'new_only', 'new_and_updated'].includes(dedupeMode)) throw new Error('Invalid dedupeMode');
    const dedupeStoreName = data.dedupeStoreName === undefined
        ? (crawlScope === 'full_platform' ? 'hepsiburada-full-platform-v1' : 'hepsiburada-seller-lead-state-v1')
        : data.dedupeStoreName;
    if (typeof dedupeStoreName !== 'string' || !/^[A-Za-z0-9._-]{3,63}$/.test(dedupeStoreName)) {
        throw new Error('dedupeStoreName must use 3-63 letters, numbers, dots, underscores, or hyphens');
    }
    const startPage = data.startPage === undefined || data.startPage === null
        ? null
        : integer(data.startPage, 1, 1, 1_000_000, 'startPage');
    if (crawlScope === 'full_platform' && startPage !== null) throw new Error('startPage is only supported in custom mode');
    return {
        campaignId: identifier(data.campaignId, 'campaignId'),
        shardId: identifier(data.shardId, 'shardId'),
        crawlScope,
        maxCategoriesPerRun: integer(data.maxCategoriesPerRun, 1, 1, 50, 'maxCategoriesPerRun'),
        accessMode,
        apifyProxyCountry: apifyProxyCountry.toUpperCase(),
        searchQueries,
        startUrls,
        sellerCities: strings(data.sellerCities, [], 'sellerCities'),
        sellerTypes: strings(data.sellerTypes, [], 'sellerTypes'),
        maxPagesPerSource: integer(data.maxPagesPerSource, 1, 1, 20, 'maxPagesPerSource'),
        startPage,
        resumeFromCheckpoint: boolean(data.resumeFromCheckpoint, true, 'resumeFromCheckpoint'),
        maxProductsPerSource: integer(data.maxProductsPerSource, 20, 1, 200, 'maxProductsPerSource'),
        maxProductDetails: integer(data.maxProductDetails, 30, 1, 500, 'maxProductDetails'),
        maxOtherSellersPerProduct: integer(data.maxOtherSellersPerProduct, 10, 0, 50, 'maxOtherSellersPerProduct'),
        maxSellerCandidates: integer(data.maxSellerCandidates, 50, 1, 2000, 'maxSellerCandidates'),
        maxSellers: integer(data.maxSellers, 10, 1, 500, 'maxSellers'),
        minSellerRating: number(data.minSellerRating, 0, 0, 10, 'minSellerRating'),
        minFollowerCount: integer(data.minFollowerCount, 0, 0, 1_000_000_000, 'minFollowerCount'),
        minProductCount: integer(data.minProductCount, 0, 0, 10_000_000, 'minProductCount'),
        minSellerReviewCount: integer(data.minSellerReviewCount, 0, 0, 1_000_000_000, 'minSellerReviewCount'),
        requireSellerProfile: boolean(data.requireSellerProfile, true, 'requireSellerProfile'),
        maxConcurrency: integer(data.maxConcurrency, 3, 1, 8, 'maxConcurrency'),
        maxProfileConcurrency: integer(data.maxProfileConcurrency, 3, 1, 8, 'maxProfileConcurrency'),
        maxRequestRetries: integer(data.maxRequestRetries, 2, 0, 5, 'maxRequestRetries'),
        navigationTimeoutSecs: integer(data.navigationTimeoutSecs, 180, 30, 300, 'navigationTimeoutSecs'),
        dedupeMode,
        dedupeStoreName,
        contactEnrichment: boolean(data.contactEnrichment, false, 'contactEnrichment'),
        maxContactEnrichmentLeads: integer(data.maxContactEnrichmentLeads, 5, 0, 50, 'maxContactEnrichmentLeads'),
        maxWebsiteCandidates: integer(data.maxWebsiteCandidates, 3, 1, 5, 'maxWebsiteCandidates'),
        minContactConfidence: integer(data.minContactConfidence, 70, 0, 100, 'minContactConfidence'),
    };
}
