import type { UnlockerUsage } from './types.js';

export interface UnlockerOptions {
    apiKey: string;
    zone: string;
    timeoutMillis: number;
    maxAttempts: number;
}

export class BrightDataUnlocker {
    readonly usage: UnlockerUsage = {
        logical_requests: 0,
        request_attempts: 0,
        successful_requests: 0,
        failed_attempts: 0,
        static_requests: 0,
        rendered_requests: 0,
        estimated_cost_usd: 0,
    };

    constructor(private readonly options: UnlockerOptions, private readonly fetcher: typeof fetch = fetch) {}

    async fetchHtml(url: string, render = false): Promise<string> {
        this.usage.logical_requests += 1;
        let lastError: unknown;
        for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
            this.usage.request_attempts += 1;
            if (render) this.usage.rendered_requests += 1;
            else this.usage.static_requests += 1;
            try {
                const response = await this.fetcher('https://api.brightdata.com/request', {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${this.options.apiKey}`,
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify({
                        zone: this.options.zone,
                        url,
                        format: 'raw',
                        country: 'tr',
                        render: String(render),
                    }),
                    signal: AbortSignal.timeout(this.options.timeoutMillis),
                });
                const body = await response.text();
                if (!response.ok) throw new Error(`Web Unlocker returned HTTP ${response.status}: ${body.slice(0, 300)}`);
                const brightDataError = response.headers.get('x-brd-error');
                if (brightDataError) throw new Error(`Bright Data error: ${brightDataError}`);
                if (!body.trim()) throw new Error('Web Unlocker returned an empty body');
                if (/access denied|verify you are human|forbidden/i.test(stripHtml(body).slice(0, 2_000))) {
                    throw new Error('Web Unlocker returned a blocked page');
                }
                this.usage.successful_requests += 1;
                this.usage.estimated_cost_usd = Number((this.usage.successful_requests * 0.0015).toFixed(6));
                return body;
            } catch (error) {
                lastError = error;
                this.usage.failed_attempts += 1;
                if (attempt < this.options.maxAttempts) {
                    await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
                }
            }
        }
        throw lastError;
    }
}

export function stripHtml(html: string): string {
    return html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
        .replace(/&quot;/gi, '"')
        .replace(/&apos;|&#39;/gi, "'")
        .replace(/&amp;/gi, '&')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
