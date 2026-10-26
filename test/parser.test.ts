import { describe, expect, it } from 'vitest';

import { extractProductUrls, parseMerchantProfile, parseProductPage } from '../src/parser.js';

const script = (id: string, value: unknown) => `<script type="mime/invalid" id="${id}">${JSON.stringify(value)}</script>`;
const component = (name: string, value: unknown) => `<script>window.${name}=Object.assign(window.${name}||{}, {'fixture': {'STATE': ${JSON.stringify(value)}}});</script>`;

describe('Hepsiburada parsers', () => {
    it('extracts and deduplicates product links', () => {
        const html = '<a href="/coffee-p-HBCV123?x=1">A</a><a href="https://www.hepsiburada.com/coffee-p-HBCV123?x=1">B</a>';
        expect(extractProductUrls(html, 'https://www.hepsiburada.com/ara?q=coffee')).toEqual([
            'https://www.hepsiburada.com/coffee-p-HBCV123?x=1',
        ]);
    });

    it('parses winner and other seller evidence from reduxStore', () => {
        const html = script('reduxStore', {
            productState: {
                product: {
                    productId: 'HBC1', sku: 'SKU1', name: 'Coffee maker', brand: 'Acme', merchantCity: 'ISTANBUL', merchantCountry: 'TÜRKİYE',
                    merchant: { id: 'seller-1', name: 'Official Store', urlPostfix: 'official-store', labelName: 'Yetkili Satıcı', lifetimeRating: 9.8, ratingQuantity: 50 },
                    prices: [{ value: 1200, currency: 0, discountRate: 10 }], shipmentInformation: { freeShipping: true }, numberOfInstallments: 9,
                    categories: [{ categoryName: 'Kitchen' }, { categoryName: 'Coffee Machines' }],
                    listings: [{ merchantId: 'seller-2', merchantName: 'Other Store', merchantCity: 'ANKARA', merchantCountry: 'TÜRKİYE', prices: [{ value: 1250, currency: 0 }], freeShipping: false, ratingSummary: { lifetimeRating: 9.1, ratingQuantity: 10 }, merchantInfo: { id: 'seller-2', name: 'Other Store', urlPostfix: 'other-store' } }],
                },
                seoInformation: { canonicalUrl: 'https://www.hepsiburada.com/coffee-p-HBC1', description: 'A coffee maker', productStructuredData: { '@graph': [{ '@type': 'Product', aggregateRating: { ratingValue: 4.6, ratingCount: 123 } }] } },
                paymentOptions: [{ title: '3 taksit' }],
            },
        });
        const output = parseProductPage(html, 'https://www.hepsiburada.com/coffee-p-HBC1', 10);
        expect(output).toHaveLength(2);
        expect(output[0]).toMatchObject({ seller_id: 'seller-1', seller_type: 'Yetkili Satıcı', product_rating: 4.6, product_review_count: 123, price: 1200, price_currency: 'TRY' });
        expect(output[1]).toMatchObject({ seller_id: 'seller-2', seller_city: 'ANKARA', price: 1250 });
        expect(output[0].installment_terms).toContain('3 taksit');
        expect(output[0].installment_terms).toContain('9 taksit');
        expect(output[0].promotion_info).toEqual(['%10 indirim', 'Ücretsiz kargo']);
    });

    it('parses public merchant profile and registration fields', () => {
        const html = [
            component('MCONTENT.MERCHANTINFO', { data: { merchantId: 'seller-1', followerCount: 107, totalProductCount: '436', merchantDetail: { id: 'seller-1', urlPostfix: 'viratech', displayedName: 'VİRATECH', rating: { rating: 8.5, feedbackCount: 15 }, isWomenEnt: false } } }),
            component('MCONTENT.MERCHANTTABS', { data: { merchantDetail: { id: 'seller-1', urlPostfix: 'viratech', displayedName: 'VİRATECH MEDİKAL TİCARET LİMİTED ŞİRKETİ' }, totalProductCount: 436 } }),
            component('MCONTENT.MERCHANTPROFILE', { data: { merchantDetail: { id: 'seller-1', urlPostfix: 'viratech', additionalInfo: { answerDuration: '0-12 saat', primaryShippingCity: 'TRABZON', avgDispatchTime: '1 gün', timeOnHepsiburada: '8 ay' }, properties: [{ key: 'Ticaret Ünvanı', val: 'VİRATECH MEDİKAL TİCARET LİMİTED ŞİRKETİ' }, { key: 'VKN', val: '9251318635' }, { key: 'Mersis No', val: '0925131863500001' }, { key: 'Merkez Adresi', val: 'Trabzon' }] } } }),
        ].join('');
        expect(parseMerchantProfile(html)).toMatchObject({
            seller_id: 'seller-1', seller_name: 'VİRATECH', seller_rating: 8.5, seller_review_count: 15,
            follower_count: 107, product_count: 436, shipping_city: 'TRABZON', average_dispatch_time: '1 gün',
            customer_service_response_time: '0-12 saat', time_on_hepsiburada: '8 ay', tax_number: '9251318635',
            mersis_number: '0925131863500001', registered_address: 'Trabzon',
        });
    });
});
