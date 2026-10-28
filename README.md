# Hepsiburada Seller Scraper

Custom Apify Actor for discovering Hepsiburada merchant leads. The default `full_platform` scope traverses a versioned manifest of 18 top-level categories extracted from the current public navigation. Custom keyword, category, product, and store URL discovery remains available through `crawlScope: "custom"`.

## Resumable full-catalog crawl

Each Run handles a bounded number of categories and pages. In `full_platform` mode, `maxCategoriesPerRun` selects the first unfinished categories and every category owns an independent cursor in `dedupeStoreName`. A page is marked complete only after its selected product details and seller candidates have been processed. Partial pages retain their seller progress and retry only unfinished work.

The persistent state store caches completed pages, parsed product details, and parsed seller profiles. Re-running a completed page therefore makes no Bright Data request for that page; overlapping pages/categories reuse product and profile results. Use one store name per campaign and avoid running the same source/page concurrently. The default `dedupeMode` is `new_only`, so the Dataset emits one row per Hepsiburada `seller_id`; Aime should still upsert by `platform + seller_id` during cross-Run aggregation.

`OUTPUT.next_cursor.sources[]` contains `source_id`, `source_url`, `next_page`, and `exhausted` for all manifest categories. `total_category_count`, `completed_category_count`, `remaining_category_count`, `categories_processed_this_run`, and `current_category` expose platform-level progress. Aime should leave `startPage` unset and start another shard while `has_more` is true.

## Data flow

```text
crawlScope=full_platform / versioned category manifest
        |
        v
Hepsiburada search/category pages -- extract product URLs
        |
        v
Product reduxStore -- winner + other sellers + product evidence
        |
        v
Store profile component state -- followers, products, rating, logistics, legal fields
        |
        v
qualification + cross-run dedupe -- incremental Dataset checkpoint
```

The parser reads server-rendered JSON state (`reduxStore` and `MCONTENT.MERCHANT*`) instead of generated CSS classes. Missing public values remain `null` or empty arrays.

## Main input

| Field | Meaning |
| --- | --- |
| `campaignId`, `shardId` | Optional Aime pass-through tracing IDs |
| `crawlScope` | `full_platform` (default) or `custom` |
| `maxCategoriesPerRun` | Maximum unfinished manifest categories scheduled in one Run |
| `accessMode`, `apifyProxyCountry` | Network path: direct, Apify Residential Proxy, Bright Data, or fallback chain |
| `searchQueries`, `startUrls` | Custom-mode discovery sources; leave empty in full-platform mode |
| `maxSellers` | Maximum qualified sellers checkpointed to Dataset |
| `maxSellerCandidates` | Maximum public store profiles inspected |
| `minSellerRating`, `minFollowerCount`, `minProductCount`, `minSellerReviewCount` | Seller qualification filters |
| `sellerCities`, `sellerTypes` | Optional exact public-profile filters |
| `dedupeMode`, `dedupeStoreName` | Cross-run seller deduplication |

When both discovery fields are empty, the Actor traverses the complete built-in platform manifest. It automatically skips exhausted categories and continues the first unfinished category in later Runs that use the same `dedupeStoreName`.

## Output

One Dataset row is one seller. It includes:

- tracing: `campaign_id`, `shard_id`, `run_id`, `seller_id`;
- store: name/profile, type, score, followers, product count, review count;
- operations: shipping city, average dispatch time, customer-service response time, time on Hepsiburada;
- public business registration: trade name, registered email when public, VKN, MERSIS, registered address;
- verified public contacts: likely official website, public business emails/phones, WhatsApp and social links, source URLs and confidence;
- representative product: brand, categories, title, score/reviews, price, promotion text, description, installment terms;
- quality/dedupe: lead score, qualification reasons, first/last seen, times seen.

Qualified rows are written immediately with `Actor.pushData`, so already checkpointed records survive timeout or abort. `OUTPUT` and `PROGRESS` contain shard-level counts and the default Dataset ID. Aime remains responsible for campaign scheduling and cross-Run aggregation using `campaign_id + seller_id`.

## Access and cost

Direct cloud requests to Hepsiburada have timed out in previous tests. The default `accessMode: "apify_proxy"` routes every request through Apify Residential Proxy with Turkey routing and never calls Bright Data. `bright_data` preserves the previous Web Unlocker path as an explicit fallback, while `auto` tries direct, Apify Proxy, then Bright Data when configured.

With the current Bright Data plan, each successful page request is estimated at **$0.0015**. Approximate successful requests are:

```text
listing pages + product detail pages + unique seller profile pages + optional contact search/website pages
```

For example, 1 search page + 5 product pages + 10 seller profiles is about 16 successful unlock requests, or roughly **$0.024**, plus Apify compute. Actual runs may use more requests when retries are needed.

Contact enrichment is disabled by default for full-platform runs. When explicitly enabled, the Actor searches Bing through the same Web Unlocker, rejects marketplace/directory/social domains as official websites, then verifies candidates against the seller/store name, legal trade name, VKN, MERSIS, city and evidenced brands. Missing or ambiguous contacts remain empty; values are never guessed.

## Local validation

```bash
npm install
npm test
npm run typecheck
npm run build
apify validate-schema
```

Local Bright Data runs require `BRIGHT_DATA_API_KEY`. Apify Residential Proxy is intended for cloud Actor runs; local external proxy access depends on the Apify account plan.
