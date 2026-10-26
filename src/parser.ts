import type { MerchantProfile, ProductEvidence } from './types.js';

type UnknownRecord = Record<string, unknown>;

const record = (value: unknown): UnknownRecord | null => value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const numeric = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value.replace(/\./g, '').replace(',', '.'));
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};
const boolean = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;

function extractBalancedObject(source: string, searchFrom: number): string | null {
    const start = source.indexOf('{', searchFrom);
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
        const char = source[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') depth += 1;
        else if (char === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    return null;
}

export function parseReduxStore(html: string): UnknownRecord | null {
    const match = html.match(/<script[^>]*id=["']reduxStore["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!match) return null;
    try {
        return record(JSON.parse(match[1]));
    } catch {
        return null;
    }
}

export function parseComponentState(html: string, component: string): UnknownRecord | null {
    const componentIndex = html.indexOf(`window.${component}`);
    if (componentIndex < 0) return null;
    const scriptEnd = html.indexOf('</script>', componentIndex);
    const source = html.slice(componentIndex, scriptEnd < 0 ? undefined : scriptEnd);
    const marker = source.match(/["']STATE["']\s*:/);
    if (!marker || marker.index === undefined) return null;
    const raw = extractBalancedObject(source, marker.index + marker[0].length);
    if (!raw) return null;
    try {
        return record(JSON.parse(raw));
    } catch {
        return null;
    }
}

export function isProductUrl(value: string): boolean {
    try {
        return /-(?:p|pm)-[A-Z0-9]+/i.test(new URL(value).pathname);
    } catch {
        return false;
    }
}

export function isStoreUrl(value: string): boolean {
    try {
        return /^\/magaza\/[^/]+/i.test(new URL(value).pathname);
    } catch {
        return false;
    }
}

export function extractProductUrls(html: string, baseUrl: string): string[] {
    const links = [...html.matchAll(/href=["']([^"']+-(?:p|pm)-[A-Z0-9]+[^"']*)["']/gi)]
        .map((match) => match[1].replace(/&amp;/gi, '&'))
        .flatMap((value) => {
            try {
                const url = new URL(value, baseUrl);
                if (!/(^|\.)hepsiburada\.com$/i.test(url.hostname)) return [];
                url.hash = '';
                return [url.toString()];
            } catch {
                return [];
            }
        });
    return [...new Set(links)];
}

function readableStrings(value: unknown, max = 10, depth = 0): string[] {
    if (depth > 4 || value === null || value === undefined) return [];
    if (typeof value === 'string') {
        const normalized = value.trim();
        return normalized && normalized.length <= 300 && !/^https?:\/\//i.test(normalized) ? [normalized] : [];
    }
    if (Array.isArray(value)) return value.flatMap((item) => readableStrings(item, max, depth + 1)).slice(0, max);
    const object = record(value);
    if (!object) return [];
    return Object.entries(object)
        .filter(([key]) => /name|title|text|description|label|display/i.test(key))
        .flatMap(([, item]) => readableStrings(item, max, depth + 1))
        .slice(0, max);
}

function currency(value: unknown): string | null {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value === 0) return 'TRY';
    return null;
}

function isTurkey(value: string): boolean {
    const normalized = value.toLocaleLowerCase('tr-TR');
    return normalized === 'türkiye' || normalized === 'turkey';
}

function merchantLabel(merchant: UnknownRecord | null, listing: UnknownRecord | null): string | null {
    const direct = text(merchant?.labelName);
    if (direct) return direct;
    const labels = readableStrings(listing?.merchantLabels ?? listing?.merchantInfo, 3);
    return labels[0] ?? null;
}

function evidenceForMerchant(
    product: UnknownRecord,
    merchant: UnknownRecord,
    listing: UnknownRecord | null,
    shared: Omit<ProductEvidence, 'seller_id' | 'seller_name' | 'seller_profile_url' | 'seller_type' | 'seller_rating' | 'seller_rating_count' | 'seller_city' | 'seller_country' | 'seller_country_code' | 'is_women_entrepreneur' | 'price' | 'price_currency' | 'free_shipping'>,
): ProductEvidence | null {
    const sellerId = text(merchant.id ?? listing?.merchantId);
    const sellerName = text(merchant.name ?? listing?.merchantName);
    const sellerSlug = text(merchant.urlPostfix);
    if (!sellerId || !sellerName || !sellerSlug) return null;
    const ratingSummary = record(listing?.ratingSummary ?? merchant.ratingSummary);
    const prices = array(listing?.prices ?? product.prices).map(record).filter((item): item is UnknownRecord => item !== null);
    const price = numeric(prices[0]?.value ?? listing?.originalPrice);
    const sellerCountry = text(listing?.merchantCountry ?? product.merchantCountry ?? merchant.country);
    return {
        ...shared,
        seller_id: sellerId,
        seller_name: sellerName,
        seller_profile_url: `https://www.hepsiburada.com/magaza/${encodeURIComponent(sellerSlug)}?tab=profile`,
        seller_type: merchantLabel(merchant, listing),
        seller_rating: numeric(ratingSummary?.lifetimeRating ?? merchant.lifetimeRating),
        seller_rating_count: numeric(ratingSummary?.ratingQuantity ?? merchant.ratingQuantity),
        seller_city: text(listing?.merchantCity ?? product.merchantCity ?? merchant.city),
        seller_country: sellerCountry,
        seller_country_code: sellerCountry && isTurkey(sellerCountry) ? 'TR' : null,
        is_women_entrepreneur: boolean(listing?.womanEntrepreneur ?? merchant.isWomenEnt),
        price,
        price_currency: currency(prices[0]?.currency) ?? 'TRY',
        free_shipping: boolean(listing?.freeShipping ?? record(product.shipmentInformation)?.freeShipping),
    };
}

export function parseProductPage(html: string, sourceUrl: string, maxOtherSellers = 10): ProductEvidence[] {
    const redux = parseReduxStore(html);
    const productState = record(redux?.productState);
    const product = record(productState?.product);
    if (!product) return [];
    const seo = record(productState?.seoInformation);
    const structured = record(seo?.productStructuredData ?? productState?.productStructuredData);
    const graph = array(structured?.['@graph']).map(record).find((item) => item?.['@type'] === 'Product') ?? null;
    const aggregateRating = record(graph?.aggregateRating);
    const categories = array(product.categories).map(record).flatMap((item) => text(item?.categoryName) ?? []).slice(0, 10);
    const canonicalUrl = text(seo?.canonicalUrl ?? structured?.url) ?? sourceUrl;
    const basePrice = array(product.prices).map(record).find((item): item is UnknownRecord => item !== null);
    const discountRate = numeric(basePrice?.discountRate);
    const promotions = [...new Set([
        ...readableStrings(product.campaigns, 10),
        ...readableStrings(productState?.campaigns, 10),
        ...(discountRate && discountRate > 0 ? [`%${discountRate} indirim`] : []),
        ...(record(product.shipmentInformation)?.freeShipping === true ? ['Ücretsiz kargo'] : []),
    ])].slice(0, 10);
    const installmentCount = numeric(product.numberOfInstallments);
    const installmentTerms = [...new Set([
        ...readableStrings(product.paymentOptions, 10),
        ...readableStrings(productState?.paymentOptions, 10),
        ...readableStrings(productState?.paymentsResponseData, 10),
        ...(installmentCount && installmentCount > 1 ? [`${installmentCount} taksit`] : []),
    ])].slice(0, 10);
    const shared = {
        product_id: text(product.productId),
        sku: text(product.sku),
        product_url: canonicalUrl,
        product_title: text(product.name ?? graph?.name),
        brand: text(product.brand ?? record(graph?.brand)?.name),
        categories,
        product_rating: numeric(aggregateRating?.ratingValue ?? record(seo?.utagData)?.review_rate),
        product_review_count: numeric(aggregateRating?.ratingCount ?? record(seo?.utagData)?.review_count),
        promotion_info: promotions,
        product_description: text(product.description ?? graph?.description ?? seo?.description),
        product_description_source: product.description ? 'product_state' : graph?.description ? 'structured_data' : seo?.description ? 'seo' : null,
        installment_terms: installmentTerms,
    } satisfies Omit<ProductEvidence, 'seller_id' | 'seller_name' | 'seller_profile_url' | 'seller_type' | 'seller_rating' | 'seller_rating_count' | 'seller_city' | 'seller_country' | 'seller_country_code' | 'is_women_entrepreneur' | 'price' | 'price_currency' | 'free_shipping'>;
    const output: ProductEvidence[] = [];
    const winner = record(product.merchant);
    if (winner) {
        const evidence = evidenceForMerchant(product, winner, null, shared);
        if (evidence) output.push(evidence);
    }
    for (const listing of array(product.listings).slice(0, maxOtherSellers).map(record)) {
        if (!listing) continue;
        const merchant = record(listing.merchantInfo) ?? {
            id: listing.merchantId,
            name: listing.merchantName,
            urlPostfix: listing.urlPostfix,
        };
        const evidence = evidenceForMerchant(product, merchant, listing, shared);
        if (evidence && !output.some((item) => item.seller_id === evidence.seller_id)) output.push(evidence);
    }
    return output;
}

function propertyMap(properties: unknown): Map<string, string> {
    return new Map(array(properties).map(record).flatMap((item) => {
        const key = text(item?.key);
        const value = text(item?.val);
        return key ? [[key.toLocaleLowerCase('tr-TR'), value ?? ''] as const] : [];
    }));
}

function property(properties: Map<string, string>, ...names: string[]): string | null {
    for (const name of names) {
        const value = properties.get(name.toLocaleLowerCase('tr-TR'));
        if (value) return value;
    }
    return null;
}

export function parseMerchantProfile(html: string): MerchantProfile | null {
    const infoState = parseComponentState(html, 'MCONTENT.MERCHANTINFO');
    const tabsState = parseComponentState(html, 'MCONTENT.MERCHANTTABS');
    const profileState = parseComponentState(html, 'MCONTENT.MERCHANTPROFILE');
    const info = record(infoState?.data);
    const infoDetail = record(info?.merchantDetail);
    const tabs = record(tabsState?.data);
    const tabsDetail = record(tabs?.merchantDetail);
    const profile = record(profileState?.data);
    const detail = record(profile?.merchantDetail);
    const sellerId = text(detail?.id ?? info?.merchantId ?? infoDetail?.id ?? tabsDetail?.id);
    const sellerSlug = text(detail?.urlPostfix ?? infoDetail?.urlPostfix ?? tabsDetail?.urlPostfix);
    if (!sellerId || !sellerSlug) return null;
    const rating = record(infoDetail?.rating);
    const additional = record(detail?.additionalInfo);
    const properties = propertyMap(detail?.properties);
    return {
        seller_id: sellerId,
        seller_slug: sellerSlug,
        seller_name: text(infoDetail?.displayedName ?? tabsDetail?.displayedName),
        seller_profile_url: `https://www.hepsiburada.com/magaza/${encodeURIComponent(sellerSlug)}?tab=profile`,
        seller_rating: numeric(rating?.rating),
        seller_review_count: numeric(rating?.feedbackCount),
        follower_count: numeric(info?.followerCount),
        product_count: numeric(info?.totalProductCount ?? tabs?.totalProductCount),
        shipping_city: text(additional?.primaryShippingCity),
        average_dispatch_time: text(additional?.avgDispatchTime),
        customer_service_response_time: text(additional?.answerDuration),
        time_on_hepsiburada: text(additional?.timeOnHepsiburada),
        trade_name: property(properties, 'Ticaret Ünvanı') ?? text(tabsDetail?.displayedName),
        registered_email: property(properties, 'Kayıtlı E-Posta Adresi'),
        tax_number: property(properties, 'VKN'),
        mersis_number: property(properties, 'Mersis No'),
        registered_address: property(properties, 'Merkez Adresi'),
        contact_disclosure: property(properties, 'İletişim'),
        is_women_entrepreneur: boolean(infoDetail?.isWomenEnt ?? detail?.isWomenEnt),
    };
}
