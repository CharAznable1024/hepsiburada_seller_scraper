import type { ProxyConfiguration } from 'apify';
import { describe, expect, it } from 'vitest';

import { ApifyResidentialFetcher } from '../src/apify-proxy.js';

const proxy = { newUrl: async () => 'http://user:pass@proxy.example:8000' } as unknown as ProxyConfiguration;

describe('ApifyResidentialFetcher', () => {
    it('fetches HTML through the supplied proxy and records traffic', async () => {
        const fetcher = new ApifyResidentialFetcher(proxy, 1_000, 1, async () => ({
            statusCode: 200,
            body: '<html>merchant page</html>',
            rawBody: Buffer.from('<html>merchant page</html>'),
        }));
        expect(await fetcher.fetchHtml('https://example.com')).toContain('merchant page');
        expect(fetcher.usage.successful_requests).toBe(1);
        expect(fetcher.usage.response_bytes).toBeGreaterThan(0);
    });

    it('rejects blocked responses without using another access provider', async () => {
        const fetcher = new ApifyResidentialFetcher(proxy, 1_000, 1, async () => ({
            statusCode: 403,
            body: '<html>Access denied</html>',
        }));
        await expect(fetcher.fetchHtml('https://example.com')).rejects.toThrow('HTTP 403');
        expect(fetcher.usage.failed_attempts).toBe(1);
    });
});
