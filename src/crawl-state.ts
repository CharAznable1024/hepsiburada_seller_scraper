import { createHash } from 'node:crypto';

import type { SourceCursor } from './types.js';

export interface StateStore {
    getValue<T>(key: string): Promise<T | null>;
    setValue(key: string, value: unknown): Promise<void>;
}

export interface PageProgress {
    status: 'in_progress' | 'completed';
    source_id: string;
    source_url: string;
    label: string;
    page: number;
    product_urls: string[];
    processed_seller_ids: string[];
    discovered_at: string;
    updated_at: string;
    completed_at?: string;
}

interface StoredCursor {
    next_page: number;
    exhausted: boolean;
    updated_at: string;
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 32);

export function canonicalSourceUrl(value: string, pageParameter: string): string {
    const url = new URL(value);
    url.searchParams.delete(pageParameter);
    url.hash = '';
    return url.toString();
}

export function sourceId(value: string, pageParameter: string): string {
    return hash(canonicalSourceUrl(value, pageParameter));
}

export class CrawlState {
    constructor(private readonly store: StateStore, private readonly pageParameter: string) {}

    private sourceId(sourceUrl: string): string {
        return sourceId(sourceUrl, this.pageParameter);
    }

    private cursorKey(sourceUrl: string): string {
        return `CRAWL_CURSOR_${this.sourceId(sourceUrl)}`;
    }

    private pageKey(sourceUrl: string, page: number): string {
        return `CRAWL_PAGE_${this.sourceId(sourceUrl)}_${page}`;
    }

    async resolveStartPage(sourceUrl: string, explicitStartPage: number | null, resume: boolean): Promise<number> {
        if (explicitStartPage !== null) return explicitStartPage;
        if (!resume) return 1;
        const cursor = await this.store.getValue<StoredCursor>(this.cursorKey(sourceUrl));
        return cursor?.next_page ?? 1;
    }

    async getPage(sourceUrl: string, page: number): Promise<PageProgress | null> {
        return this.store.getValue<PageProgress>(this.pageKey(sourceUrl, page));
    }

    async beginPage(sourceUrl: string, label: string, page: number, productUrls: string[]): Promise<PageProgress> {
        const now = new Date().toISOString();
        const progress: PageProgress = {
            status: 'in_progress',
            source_id: this.sourceId(sourceUrl),
            source_url: canonicalSourceUrl(sourceUrl, this.pageParameter),
            label,
            page,
            product_urls: [...new Set(productUrls)],
            processed_seller_ids: [],
            discovered_at: now,
            updated_at: now,
        };
        await this.store.setValue(this.pageKey(sourceUrl, page), progress);
        return progress;
    }

    async savePage(progress: PageProgress): Promise<void> {
        progress.updated_at = new Date().toISOString();
        await this.store.setValue(this.pageKey(progress.source_url, progress.page), progress);
    }

    async markSellerProcessed(progress: PageProgress, sellerId: string): Promise<void> {
        if (!progress.processed_seller_ids.includes(sellerId)) progress.processed_seller_ids.push(sellerId);
        await this.savePage(progress);
    }

    async completePage(progress: PageProgress, exhausted: boolean): Promise<void> {
        const now = new Date().toISOString();
        progress.status = 'completed';
        progress.completed_at = now;
        progress.updated_at = now;
        await this.store.setValue(this.pageKey(progress.source_url, progress.page), progress);
        await this.store.setValue(this.cursorKey(progress.source_url), {
            next_page: exhausted ? progress.page : progress.page + 1,
            exhausted,
            updated_at: now,
        } satisfies StoredCursor);
    }

    async hasSeenListing(sourceUrl: string, productUrls: string[]): Promise<boolean> {
        if (productUrls.length === 0) return false;
        const signature = hash([...new Set(productUrls)].sort().join('\n'));
        return (await this.store.getValue<{ first_seen_at: string }>(`CRAWL_LISTING_${this.sourceId(sourceUrl)}_${signature}`)) !== null;
    }

    async rememberListing(sourceUrl: string, page: number, productUrls: string[]): Promise<void> {
        if (productUrls.length === 0) return;
        const signature = hash([...new Set(productUrls)].sort().join('\n'));
        await this.store.setValue(`CRAWL_LISTING_${this.sourceId(sourceUrl)}_${signature}`, {
            page,
            first_seen_at: new Date().toISOString(),
        });
    }

    async cursor(sourceUrl: string, label: string, fallbackPage: number): Promise<SourceCursor> {
        const stored = await this.store.getValue<StoredCursor>(this.cursorKey(sourceUrl));
        return {
            source_id: this.sourceId(sourceUrl),
            source_url: canonicalSourceUrl(sourceUrl, this.pageParameter),
            label,
            next_page: stored?.next_page ?? fallbackPage,
            exhausted: stored?.exhausted ?? false,
        };
    }

    async getProduct<T>(url: string): Promise<T | null> {
        return this.store.getValue<T>(`CRAWL_PRODUCT_${hash(url)}`);
    }

    async setProduct(url: string, value: unknown): Promise<void> {
        await this.store.setValue(`CRAWL_PRODUCT_${hash(url)}`, value);
    }

    async getProfile<T>(sellerId: string): Promise<T | null> {
        return this.store.getValue<T>(`CRAWL_PROFILE_${hash(sellerId)}`);
    }

    async setProfile(sellerId: string, value: unknown): Promise<void> {
        await this.store.setValue(`CRAWL_PROFILE_${hash(sellerId)}`, value);
    }
}
