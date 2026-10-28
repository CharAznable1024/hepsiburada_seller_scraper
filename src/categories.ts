export interface PlatformCategory {
    id: string;
    name: string;
    url: string;
}

export const CATEGORY_MANIFEST_VERSION = 'hepsiburada-public-nav-2026-10-v1';

export const FULL_PLATFORM_CATEGORIES: PlatformCategory[] = [
    { id: '2147483638', name: 'Ev Elektroniği', url: 'https://www.hepsiburada.com/ev-elektronik-urunleri-c-2147483638' },
    { id: '2147483646', name: 'Bilgisayar ve Tablet', url: 'https://www.hepsiburada.com/bilgisayar-sistemleri-ve-ekipmanlari-c-2147483646' },
    { id: '2147483642', name: 'Telefon ve Aksesuarları', url: 'https://www.hepsiburada.com/telefonlar-c-2147483642' },
    { id: '235604', name: 'Beyaz Eşya ve Ankastre', url: 'https://www.hepsiburada.com/beyaz-esya-ankastreler-c-235604' },
    { id: '161876', name: 'Isıtma ve Soğutma', url: 'https://www.hepsiburada.com/isitma-sogutma-urunleri-c-161876' },
    { id: '17071', name: 'Elektrikli Ev Aletleri', url: 'https://www.hepsiburada.com/elektrikli-ev-aletleri-c-17071' },
    { id: '2147483606', name: 'Fotoğraf ve Kamera', url: 'https://www.hepsiburada.com/foto-kameralari-c-2147483606' },
    { id: '2147483602', name: 'Oyun ve Oyun Konsolları', url: 'https://www.hepsiburada.com/oyunlar-oyun-konsollari-c-2147483602' },
    { id: '2147483636', name: 'Giyim ve Ayakkabı', url: 'https://www.hepsiburada.com/giyim-ayakkabi-c-2147483636' },
    { id: '2147483617', name: 'Altın, Takı ve Mücevher', url: 'https://www.hepsiburada.com/altin-taki-mucevherler-c-2147483617' },
    { id: '60002028', name: 'Ev, Yaşam ve Dekorasyon', url: 'https://www.hepsiburada.com/ev-dekorasyon-c-60002028' },
    { id: '60002705', name: 'Yapı Market, Bahçe ve Oto', url: 'https://www.hepsiburada.com/yapi-market-bahce-oto-c-60002705' },
    { id: '2147483639', name: 'Anne, Bebek ve Oyuncak', url: 'https://www.hepsiburada.com/anne-bebek-oyuncak-c-2147483639' },
    { id: '60001546', name: 'Spor ve Outdoor', url: 'https://www.hepsiburada.com/spor-outdoor-urunleri-c-60001546' },
    { id: '60001547', name: 'Kozmetik ve Kişisel Bakım', url: 'https://www.hepsiburada.com/kozmetik-kisisel-bakim-urunleri-c-60001547' },
    { id: '2147483619', name: 'Süpermarket', url: 'https://www.hepsiburada.com/supermarket-c-2147483619' },
    { id: '2147483616', name: 'Pet Shop', url: 'https://www.hepsiburada.com/pet-shop-c-2147483616' },
    { id: '60001501', name: 'Kitap, Film, Müzik ve Hobi', url: 'https://www.hepsiburada.com/kitaplar-filmler-muzikler-c-60001501' },
];

export function validateCategoryManifest(categories: PlatformCategory[]): void {
    const ids = new Set<string>();
    const urls = new Set<string>();
    for (const category of categories) {
        if (!category.id || !category.name) throw new Error('Category manifest entries require id and name');
        const url = new URL(category.url);
        if (url.protocol !== 'https:' || url.hostname !== 'www.hepsiburada.com' || !/-c-\d+$/i.test(url.pathname)) {
            throw new Error(`Invalid Hepsiburada category URL: ${category.url}`);
        }
        if (ids.has(category.id) || urls.has(category.url)) throw new Error(`Duplicate category manifest entry: ${category.id}`);
        ids.add(category.id);
        urls.add(category.url);
    }
}

export function selectPendingCategories<T extends { url: string }>(
    categories: T[],
    exhaustedUrls: Set<string>,
    limit: number,
): T[] {
    return categories.filter((category) => !exhaustedUrls.has(category.url)).slice(0, limit);
}
