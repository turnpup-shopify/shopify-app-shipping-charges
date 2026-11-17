# Kickoff: Freight Margin Guard (Phase 1)

You are building a custom embedded Shopify app for one store (HTGT Furniture). It finds oversize products that lose money after freight, and shows the math to business users. Phase 1 is READ ONLY. The app must never write to products, prices, tags, shipping or channels in this phase.

## Before you write code

1. Check current Shopify docs and confirm, then tell me what you found:
   - The current Shopify CLI app template (I believe it is the React Router template, which replaced Remix)
   - How a Dev Dashboard app with custom distribution authenticates when embedded (session tokens, token exchange, online vs offline tokens)
   - How to get the logged in staff member's user ID from an online token
   - The bulk operations query shape for products, variants, inventory item unit cost and weight, and metafields
   - Whether Shopify CLI can deploy app config from CI with a token for Dev Dashboard apps
2. If anything I state below conflicts with current docs, follow the docs and note the difference in `DECISIONS.md`.
3. Show me a short plan before building.

## Stack

- Shopify CLI, React Router app template, TypeScript
- Polaris UI, embedded in Shopify admin
- Postgres with Prisma, hosted on Neon through the Vercel Marketplace. Use the pooled connection string for the app and the direct one for migrations.
- Hosting on Vercel, connected to the GitHub repo
- Vitest for unit tests

## Vercel setup

- Use the Vercel adapter or preset for the React Router template. Confirm the current method in the docs.
- Two Shopify apps in the Dev Dashboard, both installed on the HTGT store. **Staging** points at a fixed staging domain on Vercel (the `staging` branch). **Production** points at the production domain (the `main` branch). Shopify needs a fixed app URL, so random preview URLs are not used for Shopify testing.
- Each environment has its own env vars and its own database branch on Neon.
- Serverless rules. No long running processes and no local file storage. Every request must finish within the function time limit. Check the current limit for my plan.

## Scan design for serverless

1. A Vercel Cron job calls `/api/cron/scan` at 2am Central (08:00 UTC). Protect it with `CRON_SECRET`.
2. That route starts a Shopify bulk operation and returns right away.
3. A `bulk_operations/finish` webhook calls the app when Shopify is done.
4. The webhook handler streams the JSONL result and writes flags in batches. If the store is big enough to hit the time limit, split the work into chunks and record progress in the `scan` table.
5. Manual "Run scan now" uses the same path.

## Access scopes for Phase 1

`read_products`, `read_inventory`, `read_reports`. Nothing with write.

## Auth rules

- Staff actions use an online access token so every log row has a real Shopify user ID and name.
- The nightly scan uses the store's offline token and logs the actor as `System`.
- Do not use the client credentials grant.

## Data inputs per variant

| Field | Source |
| --- | --- |
| Price, compare at price | Variant |
| Unit cost | Inventory item unit cost |
| Weight | Inventory item measurement |
| Box length, width, height (in) | Variant metafields `freight.box_length`, `freight.box_width`, `freight.box_height` |
| Box count | Variant metafield `freight.box_count`, default 1 |
| Freight override ($) | Variant metafield `freight.override_cost` |
| MAP ($) | Variant metafield `pricing.map` |

If a metafield namespace or key does not exist yet, list what is missing on a Data Health screen. Do not create metafield definitions in Phase 1.

## Freight model (all values are editable settings)

- Size = length + 2 × width + 2 × height
- Dimensional weight = L × W × H ÷ 139
- Billable weight = max(actual weight, dimensional weight)

| Tier | Rule (any one match) | Default freight |
| --- | --- | --- |
| Parcel | Size ≤ 130 in and billable ≤ 50 lb | $25 |
| Large parcel | Size 130 to 165 in, or billable 50 to 150 lb | $120 |
| Freight (LTL) | Size > 165 in, or billable > 150 lb, or longest side > 108 in | $250 |

Override metafield always wins and shows as "Manual". Freight is multiplied by box count.

## Math

- Landed cost = unit cost + freight
- Margin after freight = (price − landed cost) ÷ price
- Margin at max discount = (price × (1 − d) − landed cost) ÷ (price × (1 − d)), d defaults to 10%
- Suggested price = max(MAP, landed cost ÷ (1 − target margin)), rounded up to a price ending of 9
- Suggested surcharge = landed cost − price × (1 − target margin)

Suggested fix, first match wins:
1. Suggested price increase ≤ 35% → Reprice
2. Suggested surcharge ≤ $150 → Freight surcharge
3. Otherwise → Showroom only or Delist
4. Also add Exclude from discounts if margin at max discount < 0

Default settings: target margin 25%, flag threshold under 20%, critical under 0%.

Phase 1 shows suggestions only. Nothing is applied.

## Required test case

Mirror. Unit cost $137. Freight tier LTL at $250. Price $328. MAP unset.

| Output | Expected |
| --- | --- |
| Landed cost | $387.00 |
| Margin after freight | −$59.00, −18.0% |
| At 10% off | −$91.80, −31.1% |
| Suggested price | $519 (516 rounded up to a 9 ending) |
| Price increase | +58% |
| Suggested surcharge | $141.00 |
| Suggested fix | Freight surcharge, plus Exclude from discounts |

Also test: missing unit cost, missing dimensions, manual override, multi box, MAP above suggested price, tier boundaries at exactly 130, 165, 50 and 150.

## Database tables

`settings_version`, `scan`, `flag`, `audit_log` as below. Proposal and change tables come in Phase 2, so leave room for them.

- `settings_version` holds id, every setting, tiers as json, created_by, created_at, reason. A new row on every change.
- `scan` holds id, started_at, finished_at, trigger, triggered_by, products_scanned, flags_found, settings_version_id
- `flag` holds id, scan_id, product_id, variant_id, snapshot json of every input, landed_cost, margin_pct, margin_at_discount_pct, severity, suggested_fix, suggested_value
- `audit_log` is append only. It holds id, at, actor_id, actor_name, event_type, product_id, before, after, inputs json, reason. No update or delete paths in code.

## Screens

1. **Dashboard.** Counts of flagged and critical, estimated monthly dollars lost, last scan time, Run scan now button
2. **Flag queue.** Image, title, price, cost, tier, landed cost, margin, suggested fix. Sort and filter on every column. Export CSV.
3. **Product detail.** A math card that reads like a receipt, every line explained, plus that product's log history
4. **Activity log.** Newest first. Filter by person, product, event and date. Export CSV.
5. **Settings.** Admin only. Editing a setting requires a reason. Shows who changed each setting last.
6. **Data health.** Products missing cost, dimensions or MAP

Every number is clickable to show how it was computed. Use plain words. Text must stay readable in light and dark mode.

## Roles

Analyst, Approver and Admin, stored in the app and mapped to Shopify staff user IDs. In Phase 1, only Admin can change settings and everyone can view everything. The first user to install the app becomes Admin.

## Jobs

- A nightly scan at 2am Central, using a Shopify bulk operation (see Scan design above)
- Manual scan from the dashboard
- Every scan writes scan started and scan finished log rows. Each flag written also writes a log row.

## Deliverables

- GitHub repo with README covering local setup, env vars and Vercel deploy
- `DECISIONS.md` logging any spec changes and why
- Unit tests for every formula above, all passing
- `vercel.json` with the cron schedule
- Staging deploy on Vercel from the `staging` branch, working inside Shopify admin
- A short list of exactly what I need to do by hand: Dev Dashboard settings, store install, env vars, Vercel and Neon setup

## Things I will do by hand

- Create the staging and production apps in the Shopify Dev Dashboard and install them on the HTGT store
- Run `shopify auth` / app linking in a browser if the sandbox cannot
- Create the Vercel project, add Neon from the Marketplace, set the staging domain, and paste in secrets

Stop and ask me before anything that needs those steps.
