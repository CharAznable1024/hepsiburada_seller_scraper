import { describe, expect, it } from 'vitest';

import { parseBingCandidateUrls, parseWebsite, testing } from '../src/contact-enrichment.js';
import type { SellerLead } from '../src/types.js';

describe('contact enrichment parsing', () => {
    it('decodes Bing redirects and excludes marketplaces and directory sites', () => {
        const encode = (value: string) => `a1${Buffer.from(value).toString('base64url')}`;
        const html = [
            `<a href="https://www.bing.com/ck/a?u=${encode('https://www.kozagift.com.tr/iletisim')}">Official</a>`,
            `<a href="https://www.bing.com/ck/a?u=${encode('https://www.hepsiburada.com/magaza/koza-gift')}">Marketplace</a>`,
            `<a href="https://www.bing.com/ck/a?u=${encode('https://sayfa.istanbul/detay/koza')}">Directory</a>`,
        ].join('');
        expect(parseBingCandidateUrls(html)).toEqual(['https://www.kozagift.com.tr/iletisim']);
    });

    it('extracts public emails, phones, WhatsApp, social links, and contact pages', () => {
        const html = `
          <html><body>
            <a href="mailto:info@example.com">Email</a>
            <a href="tel:+90 212 555 11 22">Phone</a>
            <a href="https://wa.me/905551112233">WhatsApp</a>
            <a href="https://instagram.com/example">Instagram</a>
            <a href="/iletisim">İletişim</a>
          </body></html>`;
        expect(parseWebsite(html, 'https://example.com')).toMatchObject({
            emails: ['info@example.com'],
            phones: ['+902125551122'],
            whatsappUrls: ['https://wa.me/905551112233'],
            socialUrls: ['https://instagram.com/example'],
            contactUrls: ['https://example.com/iletisim'],
        });
    });

    it('scores matching legal evidence and published contacts above threshold', () => {
        const lead = {
            seller_name: 'Koza Gift', trade_name: 'KOZA GIFT PAZARLAMA TİCARET LİMİTED ŞİRKETİ',
            registered_address: 'İstanbul', shipping_city: 'İSTANBUL', tax_number: '1234567890',
            mersis_number: '012345678900001', brands: ['Koza Gift'],
        } as unknown as SellerLead;
        const score = testing.confidence(lead, 'https://kozagift.com.tr/iletisim', [{
            text: testing.normalize('Koza Gift İstanbul 1234567890'), emails: ['info@kozagift.com.tr'], phones: [],
            whatsappUrls: [], socialUrls: [], contactUrls: [],
        }]);
        expect(score).toBeGreaterThanOrEqual(70);
    });

    it('matches a corporate website using a legal-name abbreviation', () => {
        const lead = {
            seller_name: 'Koza Gift', trade_name: 'KOZA AKADEMİ İŞ SAĞLIĞI VE GÜVENLİĞİ MÜHENDİSLİK HİZMETLERİ TİCARET LİMİTED ŞİRKETİ',
            registered_address: 'İstanbul', shipping_city: 'İSTANBUL', tax_number: null,
            mersis_number: null, brands: [],
        } as unknown as SellerLead;
        const score = testing.confidence(lead, 'https://www.kozaakademi.com.tr/', [{
            text: testing.normalize('Koza Akademi İstanbul iletişim'), emails: ['info@kozaakademi.com.tr'], phones: ['+902126712676'],
            whatsappUrls: [], socialUrls: [], contactUrls: [],
        }]);
        expect(score).toBeGreaterThanOrEqual(70);
    });
});
