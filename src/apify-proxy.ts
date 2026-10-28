import type { ProxyConfiguration } from 'apify';
import { gotScraping } from 'got-scraping';
import { createHash } from 'node:crypto';

import type { ApifyProxyUsage } from './types.js';

interface ProxyResponse {
    statusCode: number;
    body: string;
    rawBody?: Buffer;
}

type ProxyRequester = (options: {
    url: string;
    proxyUrl: string;
    timeoutMillis: number;
}) => Promise<ProxyResponse>;

export interface HtmlFetcher {
    fetchHtml(url: string, render?: boolean): Promise<string>;
}

const defaultRequester: ProxyRequester = async ({ url, proxyUrl, timeoutMillis }) => gotScraping({
    url,
    proxyUrl,
    timeout: { request: timeoutMillis },
    retry: { limit: 0 },
    throwHttpErrors: false,
    headers: { 'accept-language': 'tr-TR,tr;q=0.9,en;q=0.8' },
});

export class ApifyResidentialFetcher implements HtmlFetcher {
    readonly usage: ApifyProxyUsage = {
        logical_requests: 0,
        request_attempts: 0,
        successful_requests: 0,
        failed_attempts: 0,
        response_bytes: 0,
        response_gigabytes: 0,
    };

    constructor(
        private readonly proxyConfiguration: ProxyConfiguration,
        private readonly timeoutMillis: number,
        private readonly maxAttempts: number,
        private readonly requester: ProxyRequester = defaultRequester,
    ) {}

    async fetchHtml(url: string): Promise<string> {
        this.usage.logical_requests += 1;
        let lastError: unknown;
        const requestId = createHash('sha256').update(`${url}:${this.usage.logical_requests}`).digest('hex').slice(0, 20);
        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
            this.usage.request_attempts += 1;
            try {
                const proxyUrl = await this.proxyConfiguration.newUrl(`${requestId}${attempt}`);
                if (!proxyUrl) throw new Error('Apify Residential Proxy URL is unavailable');
                const response = await this.requester({ url, proxyUrl, timeoutMillis: this.timeoutMillis });
                const bytes = response.rawBody?.length ?? Buffer.byteLength(response.body);
                this.usage.response_bytes += bytes;
                this.usage.response_gigabytes = Number((this.usage.response_bytes / 1_000_000_000).toFixed(6));
                if (response.statusCode < 200 || response.statusCode >= 400) {
                    throw new Error(`Apify Residential Proxy returned HTTP ${response.statusCode}`);
                }
                if (!response.body.trim() || isBlockedPage(response.body)) {
                    throw new Error('Apify Residential Proxy returned a blocked or empty page');
                }
                this.usage.successful_requests += 1;
                return response.body;
            } catch (error) {
                lastError = error;
                this.usage.failed_attempts += 1;
                if (attempt < this.maxAttempts) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
            }
        }
        throw lastError;
    }
}

export class DirectPageFetcher implements HtmlFetcher {
    constructor(private readonly timeoutMillis: number, private readonly fetcher: typeof fetch = fetch) {}

    async fetchHtml(url: string): Promise<string> {
        const response = await this.fetcher(url, {
            headers: {
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
                'accept-language': 'tr-TR,tr;q=0.9,en;q=0.8',
            },
            signal: AbortSignal.timeout(this.timeoutMillis),
        });
        const html = await response.text();
        if (!response.ok || !html.trim() || isBlockedPage(html)) throw new Error(`Direct request failed with HTTP ${response.status}`);
        return html;
    }
}

export class FallbackHtmlFetcher implements HtmlFetcher {
    constructor(private readonly fetchers: HtmlFetcher[]) {
        if (fetchers.length === 0) throw new Error('At least one HTML fetcher is required');
    }

    async fetchHtml(url: string, render = false): Promise<string> {
        let lastError: unknown;
        for (const fetcher of this.fetchers) {
            try {
                return await fetcher.fetchHtml(url, render);
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError;
    }
}

export function isBlockedPage(html: string): boolean {
    return /attention required|sorry, you have been blocked|access denied|verify you are human|cf-error-details/i
        .test(html.replace(/<[^>]+>/g, ' ').slice(0, 3_000));
}
