import type { SellerLead } from './types.js';
import { BrightDataUnlocker, stripHtml } from './unlocker.js';

interface ContactOptions {
    maxCandidates: number;
    minimumConfidence: number;
}

export type ContactFields = Pick<
    SellerLead,
    | 'official_website'
    | 'public_business_emails'
    | 'public_business_phones'
    | 'whatsapp_urls'
    | 'social_urls'
    | 'contact_source_urls'
    | 'contact_confidence'
    | 'contact_status'
>;

interface ParsedWebsite {
    text: string;
    emails: string[];
    phones: string[];
    whatsappUrls: string[];
    socialUrls: string[];
    contactUrls: string[];
}

const EXCLUDED_HOSTS = [
    'bing.com', 'microsoft.com', 'google.com', 'gstatic.com', 'youtube.com',
    'hepsiburada.com', 'trendyol.com', 'n11.com', 'amazon.com.tr', 'pazarama.com',
    'facebook.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com',
    'mukellef.info', 'find.com.tr', 'firmasec.com', 'sayfa.istanbul', 'yandex.com',
];
const SOCIAL_HOSTS = ['facebook.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com', 'tiktok.com', 'youtube.com'];
const CONTACT_PATH = /iletisim|contact|bize[-_]?ulasin|hakkimizda|about|kurumsal/i;
const COMPANY_SUFFIXES = /\b(anonim|limited|şirketi|sirketi|ticaret|sanayi|pazarlama|ithalat|ihracat|a\s*ş|as|ltd|sti|ve)\b/g;
const COMPANY_SUFFIX_WORDS = new Set(['anonim', 'limited', 'sirketi', 'ticaret', 'sanayi', 'pazarlama', 'ithalat', 'ihracat', 'ltd', 'sti']);

function unique(values: Array<string | null | undefined>): string[] {
    return [...new Set(values.filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim()))];
}

function normalize(value: string): string {
    return value
        .toLocaleLowerCase('tr-TR')
        .replace(/[çÇ]/g, 'c')
        .replace(/[ğĞ]/g, 'g')
        .replace(/[ıİ]/g, 'i')
        .replace(/[öÖ]/g, 'o')
        .replace(/[şŞ]/g, 's')
        .replace(/[üÜ]/g, 'u')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function compact(value: string): string {
    return normalize(value).replace(COMPANY_SUFFIXES, ' ').replace(/\s+/g, '');
}

function identityTokens(value: string): string[] {
    return normalize(value)
        .split(/\s+/)
        .filter((token) => token.length >= 4 && !COMPANY_SUFFIX_WORDS.has(token));
}

function hostnameMatches(hostname: string, target: string): boolean {
    return hostname === target || hostname.endsWith(`.${target}`);
}

function safePublicUrl(value: string, base?: string): URL | null {
    try {
        const url = new URL(value, base);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
        if (/^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) return null;
        url.hash = '';
        return url;
    } catch {
        return null;
    }
}

function decodeHtml(value: string): string {
    return value
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function decodeBingRedirect(value: string): string | null {
    const url = safePublicUrl(decodeHtml(value), 'https://www.bing.com');
    if (!url) return null;
    const encoded = url.searchParams.get('u');
    if (!encoded?.startsWith('a1')) return null;
    try {
        return Buffer.from(encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    } catch {
        return null;
    }
}

export function parseBingCandidateUrls(html: string): string[] {
    const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((match) => decodeHtml(match[1]));
    const decoded = hrefs.flatMap((href) => [href, decodeBingRedirect(href)]);
    return unique(decoded).flatMap((value) => {
        const url = safePublicUrl(value);
        if (!url) return [];
        const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
        if (EXCLUDED_HOSTS.some((excluded) => hostnameMatches(hostname, excluded))) return [];
        return [url.toString()];
    });
}

function hrefs(html: string): string[] {
    return [...html.matchAll(/href=["']([^"']+)["']/gi)].map((match) => decodeHtml(match[1]));
}

function normalizePhone(value: string): string | null {
    const digits = value.trim().replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 13) return null;
    if (!/^(90|0)?(2|3|4|5)/.test(digits)) return null;
    if (digits.startsWith('90')) return `+${digits}`;
    if (digits.startsWith('0')) return `+90${digits.slice(1)}`;
    return `+90${digits}`;
}

export function parseWebsite(html: string, pageUrl: string): ParsedWebsite {
    const root = new URL(pageUrl);
    const rootHost = root.hostname.toLowerCase().replace(/^www\./, '');
    const links = hrefs(html);
    const emails = unique([
        ...links.filter((href) => href.toLowerCase().startsWith('mailto:')).map((href) => href.slice(7).split('?')[0].toLowerCase()),
        ...(html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []),
    ]).filter((email) => !/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(email));
    const phones = unique([
        ...links.filter((href) => href.toLowerCase().startsWith('tel:')).map((href) => normalizePhone(href.slice(4).split('?')[0])),
        ...[...stripHtml(html).matchAll(/(?:\+90|0)\s*\(?[2-5]\d{2}\)?[\s.-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}/g)].map((match) => normalizePhone(match[0])),
    ]);
    const whatsappUrls: string[] = [];
    const socialUrls: string[] = [];
    const contactUrls: string[] = [];
    for (const href of links) {
        const url = safePublicUrl(href, pageUrl);
        if (!url) continue;
        const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
        if (hostnameMatches(hostname, 'wa.me') || hostnameMatches(hostname, 'whatsapp.com')) whatsappUrls.push(url.toString());
        if (SOCIAL_HOSTS.some((social) => hostnameMatches(hostname, social))) socialUrls.push(url.toString());
        if (hostname === rootHost && CONTACT_PATH.test(`${url.pathname} ${url.search}`)) contactUrls.push(url.toString());
    }
    return {
        text: normalize(stripHtml(html).slice(0, 300_000)),
        emails,
        phones,
        whatsappUrls: unique(whatsappUrls),
        socialUrls: unique(socialUrls),
        contactUrls: unique(contactUrls).slice(0, 1),
    };
}

function confidence(lead: SellerLead, candidateUrl: string, pages: ParsedWebsite[]): number {
    const combined = pages.map((page) => page.text).join(' ');
    const host = compact(new URL(candidateUrl).hostname.replace(/^www\./, '').split('.')[0]);
    const seller = compact(lead.seller_name);
    const trade = compact(lead.trade_name ?? '');
    const tradeTokens = identityTokens(lead.trade_name ?? '');
    const sellerTokens = identityTokens(lead.seller_name);
    const brands = lead.brands.map(compact).filter((value) => value.length >= 4);
    let score = 0;
    if (seller.length >= 4 && (host.includes(seller) || seller.includes(host))) score += 35;
    if (seller.length >= 4 && compact(combined).includes(seller)) score += 20;
    if (trade.length >= 8 && compact(combined).includes(trade)) score += 35;
    const tradeHostMatches = tradeTokens.filter((token) => host.includes(token));
    const tradePageMatches = tradeTokens.filter((token) => combined.includes(token));
    if (tradeHostMatches.length >= 2 || (tradeHostMatches.length >= 1 && tradeTokens.length === 1)) score += 40;
    else if (tradeHostMatches.length >= 1) score += 25;
    if (tradePageMatches.length >= 2) score += 25;
    else if (tradePageMatches.length >= 1) score += 10;
    if (sellerTokens.filter((token) => combined.includes(token)).length >= Math.min(2, sellerTokens.length)) score += 15;
    if (lead.tax_number && combined.includes(normalize(lead.tax_number))) score += 45;
    if (lead.mersis_number && combined.includes(normalize(lead.mersis_number))) score += 45;
    if (lead.registered_address && combined.includes(normalize(lead.registered_address))) score += 5;
    if (brands.some((brand) => host.includes(brand) || compact(combined).includes(brand))) score += 15;
    if (pages.some((page) => page.emails.length || page.phones.length || page.whatsappUrls.length || page.socialUrls.length)) score += 10;
    return Math.min(100, score);
}

function searchQuery(lead: SellerLead): string {
    const identity = lead.trade_name || lead.seller_name;
    const location = lead.registered_address || lead.shipping_city || '';
    return `"${identity}" ${location} iletişim telefon e-posta`;
}

function empty(lead: SellerLead, status: ContactFields['contact_status']): ContactFields {
    return {
        official_website: null,
        public_business_emails: [...lead.public_business_emails],
        public_business_phones: [],
        whatsapp_urls: [],
        social_urls: [],
        contact_source_urls: [],
        contact_confidence: lead.registered_email ? 100 : 0,
        contact_status: lead.registered_email ? 'platform_only' : status,
    };
}

export async function enrichPublicBusinessContacts(
    lead: SellerLead,
    unlocker: BrightDataUnlocker,
    options: ContactOptions,
): Promise<ContactFields> {
    const queryUrl = `https://www.bing.com/search?q=${encodeURIComponent(searchQuery(lead))}&setlang=tr-TR&cc=tr&count=10`;
    const searchHtml = await unlocker.fetchHtml(queryUrl, false);
    const candidates = parseBingCandidateUrls(searchHtml).slice(0, options.maxCandidates);
    let best = empty(lead, 'not_found');

    for (const candidate of candidates) {
        try {
            const html = await unlocker.fetchHtml(candidate, false);
            const home = parseWebsite(html, candidate);
            const pages = [home];
            const sources = [candidate];
            for (const contactUrl of home.contactUrls) {
                if (sources.includes(contactUrl)) continue;
                try {
                    const contactHtml = await unlocker.fetchHtml(contactUrl, false);
                    pages.push(parseWebsite(contactHtml, contactUrl));
                    sources.push(contactUrl);
                } catch {
                    // The primary candidate remains usable when an extra contact page fails.
                }
            }
            const score = confidence(lead, candidate, pages);
            const found = pages.some((page) => page.emails.length || page.phones.length || page.whatsappUrls.length || page.socialUrls.length);
            if (score <= best.contact_confidence) continue;
            const verified = score >= options.minimumConfidence && found;
            best = {
                official_website: verified ? new URL('/', candidate).toString() : null,
                public_business_emails: verified ? unique([...lead.public_business_emails, ...pages.flatMap((page) => page.emails)]) : [...lead.public_business_emails],
                public_business_phones: verified ? unique(pages.flatMap((page) => page.phones)) : [],
                whatsapp_urls: verified ? unique(pages.flatMap((page) => page.whatsappUrls)) : [],
                social_urls: verified ? unique(pages.flatMap((page) => page.socialUrls)) : [],
                contact_source_urls: sources,
                contact_confidence: score,
                contact_status: verified ? 'verified' : lead.registered_email ? 'platform_only' : 'not_found',
            };
            if (best.contact_status === 'verified') break;
        } catch {
            // Search results are untrusted candidates; reject failures without failing the lead.
        }
    }
    return best;
}

export const testing = { compact, confidence, normalize, safePublicUrl };
