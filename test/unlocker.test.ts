import { describe, expect, it, vi } from 'vitest';

import { BrightDataUnlocker } from '../src/unlocker.js';

describe('BrightDataUnlocker', () => {
    it('uses Turkey static unlock requests and tracks cost', async () => {
        const mockFetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('<html>ok</html>', { status: 200 }));
        const unlocker = new BrightDataUnlocker({ apiKey: 'token', zone: 'zone', timeoutMillis: 1_000, maxAttempts: 1 }, mockFetcher as unknown as typeof fetch);
        await expect(unlocker.fetchHtml('https://www.hepsiburada.com/ara?q=test')).resolves.toContain('ok');
        const request = mockFetcher.mock.calls[0]?.[1] as RequestInit;
        expect(JSON.parse(String(request.body))).toMatchObject({ country: 'tr', render: 'false', zone: 'zone' });
        expect(unlocker.usage.successful_requests).toBe(1);
        expect(unlocker.usage.estimated_cost_usd).toBe(0.0015);
    });
});
