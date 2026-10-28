import { describe, expect, it } from 'vitest';

import { FULL_PLATFORM_CATEGORIES, selectPendingCategories, validateCategoryManifest } from '../src/categories.js';

describe('full-platform category manifest', () => {
    it('contains unique validated top-level categories covering the public navigation', () => {
        expect(FULL_PLATFORM_CATEGORIES).toHaveLength(18);
        expect(() => validateCategoryManifest(FULL_PLATFORM_CATEGORIES)).not.toThrow();
        expect(new Set(FULL_PLATFORM_CATEGORIES.map((category) => category.id)).size).toBe(FULL_PLATFORM_CATEGORIES.length);
    });

    it('skips exhausted categories and selects the next category automatically', () => {
        const [first, second] = FULL_PLATFORM_CATEGORIES;
        expect(selectPendingCategories(FULL_PLATFORM_CATEGORIES, new Set([first.url]), 1)).toEqual([second]);
    });
});
