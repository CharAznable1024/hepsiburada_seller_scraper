# Hepsiburada Seller Scraper

Custom Apify Actor for discovering Hepsiburada merchant leads. It starts from public keyword, category, product, or store URLs, discovers merchants from product pages, and enriches each merchant from the public store profile. If the caller supplies no discovery source, it automatically rotates across electronics, home & living, fashion, and beauty queries.

## Data flow

```text
searchQueries / startUrls
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
| `searchQueries` | Optional product, brand, or category phrases; empty uses balanced default categories |
| `startUrls` | Search/category/product/store URLs |
| `maxSellers` | Maximum qualified sellers checkpointed to Dataset |
| `maxSellerCandidates` | Maximum public store profiles inspected |
| `minSellerRating`, `minFollowerCount`, `minProductCount`, `minSellerReviewCount` | Seller qualification filters |
| `sellerCities`, `sellerTypes` | Optional exact public-profile filters |
| `dedupeMode`, `dedupeStoreName` | Cross-run seller deduplication |

Both discovery fields may be empty. In that case the Actor uses `elektronik`, `ev yaşam`, `moda`, and `kozmetik` automatically, then stops after `maxSellers` qualified leads.

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

Direct cloud requests to Hepsiburada currently time out. The Actor automatically uses the configured Bright Data Web Unlocker secret and Turkey routing; operators do not select a proxy mode.

With the current Bright Data plan, each successful page request is estimated at **$0.0015**. Approximate successful requests are:

```text
listing pages + product detail pages + unique seller profile pages + optional contact search/website pages
```

For example, 1 search page + 5 product pages + 10 seller profiles is about 16 successful unlock requests, or roughly **$0.024**, plus Apify compute. Actual runs may use more requests when retries are needed.

Contact enrichment is enabled by default for up to five qualified sellers. The Actor searches Bing through the same Web Unlocker, rejects marketplace/directory/social domains as official websites, then verifies candidates against the seller/store name, legal trade name, VKN, MERSIS, city and evidenced brands. A contact is marked `verified` only when the identity score reaches `minContactConfidence` and the website publishes at least one business contact or social link. Missing or ambiguous contacts remain empty; values are never guessed.

## Local validation

```bash
npm install
npm test
npm run typecheck
npm run build
apify validate-schema
```

Local live runs require `BRIGHT_DATA_API_KEY`. Cloud deployment injects the locally configured Apify secret through `.actor/actor.json`.
