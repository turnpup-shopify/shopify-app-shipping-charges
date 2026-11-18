# Decisions

Where the build differs from, or fills a gap in, the Phase 1 kickoff
(`freight-margin-guard-kickoff.md`), and why. Docs were checked on 2026-11-17.

## Platform

**1. Template and UI.** Built from the current Shopify CLI template,
`Shopify/shopify-app-template-react-router` (React Router 7, `@shopify/shopify-app-react-router` v3).
`shopify app init --template` now only offers `reactRouter` or `none`, which confirms React Router
replaced Remix. "Polaris UI" means **Polaris web components** (`<s-page>`, `<s-table>`, …), which
is what the template ships and what Shopify now recommends for embedded app pages. They follow the
admin's light or dark theme on their own, so the app sets no colors of its own.

**2. Create both apps in HTGT's own store organization, not a Partner organization.**
The kickoff says "custom distribution". In the Dev Dashboard, the distribution card only appears
for apps owned by a Partner organization. Apps created in the store's own organization are installed
from the app's Installs card instead. More importantly, from **2026-11-20** Shopify requires an IP
allowlist for custom apps installed on a store *outside* the owning organization. Vercel functions
have no fixed IPs without a paid add-on. Apps created inside the store's organization are exempt.
Partner-owned apps also need a separate approval before they can run bulk queries.
In code this is `AppDistribution.SingleMerchant`.

**3. Two Vercel projects, not one project with a `staging` branch.** Vercel only runs cron jobs on
production deployments, so a `staging` branch preview would never run the nightly scan. Each
environment gets its own Vercel project: `freight-margin-guard-staging` uses `staging` as its
production branch, and `freight-margin-guard` uses `main`. That also gives each one its own env vars
and its own database, which the kickoff asks for.

**4. Cron time.** Vercel cron schedules are UTC only. `0 8 * * *` is 2am Central in winter (CST)
and **3am** in summer (CDT). Kept at 08:00 UTC as written in the kickoff. On the Hobby plan the
job can also fire any time within that hour. Vercel now calls `vercel.json` crons a legacy feature
in favour of "Schedules", which support time zones. `vercel.json` crons still work, so they were
kept as the kickoff asks.

**5. Function time limit.** With Fluid compute, the default and Hobby maximum is 300s. Pro allows
up to 800s. The scan routes set `maxDuration: 300`, which works on either plan. Each invocation
stops starting new batches after `SCAN_TIME_BUDGET_MS` (default 240s) and hands off to a fresh
invocation.

**6. CI deploys of app config.** These are supported for Dev Dashboard apps through a **service
account token** (`SHOPIFY_SERVICE_ACCOUNT_TOKEN`, Shopify CLI 5.0+), created under Settings → Users
→ Security in the admin. A May 2026 changelog describes "app automation tokens"; the service account
docs appear to replace them. CI deploys are not wired up in Phase 1. App config is deployed by hand
with `shopify app deploy --config staging|production`.

## Auth

**7. Online tokens for staff, offline token for the scan.** `useOnlineTokens: true`. Every staff
request is authenticated with an online token, and `session.onlineAccessInfo.associated_user`
gives the Shopify user ID and name for the log. The template also stores the shop's offline token,
which the cron uses. No client credentials grant.

**8. Expiring offline tokens.** Turned on (`future.expiringOfflineAccessTokens`), as Shopify now
recommends. The template stores and refreshes the refresh token.

**9. "Run scan now" uses the offline token for the bulk query itself.** Shopify doesn't send
bulk-operation notifications for operations started with an online token. The staff member who
clicked the button is still recorded as the actor on the scan and on the "scan started" log row.

**10. "First user to install becomes Admin" means first user to open the app.** With token exchange,
the app learns who a user is only when they open it. Install and first open are normally the same
person. A database transaction makes sure only one person can become that first Admin.

## Scan

**11. Bulk query over `productVariants`, not `products → variants`.** Each JSONL line is then one
complete variant, product title included. That makes the result safe to process in chunks and to
resume by line number. Validated against Admin API 2026-10.

**12. Only active products; only variants that ship.** The bulk query filters to
`product_status:active`. Variants whose inventory item has `requiresShipping: false` are skipped.

**13. Chunking and recovery.**
- The webhook replies to Shopify at once and keeps working in the background with Vercel's `waitUntil`.
- Each batch of 250 lines writes its flags, data gaps, log rows and new resume point in **one
  transaction**, so a crash never leaves a half-written batch.
- A lease (`scan.lease_until`) stops two invocations from processing the same scan at once.
- When time runs short, the worker calls `POST /api/scan/continue` (protected by `CRON_SECRET`),
  which picks up at `scan.lines_processed`.
- The nightly cron also resumes stuck scans: a missed webhook, a dead worker, or a scan that never
  started. The dashboard checks a running scan's bulk operation directly after 2 minutes, in case the
  webhook was missed.

**14. `products_scanned`** is the count of active products (`productsCount`). A
`variants_scanned` column was added because flags are per variant.

## Freight model and math

**15. Size.** "Length" is taken as the longest side: size = longest + 2 × the other two sides.
Dimensions and dimensional weight are per box.

**16. Tier order and boundaries.** Tiers are checked smallest first. A box fits a tier only if it is
at or under every limit; the last tier catches the rest. This matches the kickoff's "any one match"
rule for LTL:

| Edge case | Result |
| --- | --- |
| Size exactly 130 | Parcel |
| Size exactly 165 | Large parcel |
| Billable weight exactly 50 | Parcel |
| Billable weight exactly 150 | Large parcel |
| Longest side exactly 108 | Not forced to LTL |
| Longest side over 108 | LTL, even if small and light |

The 108 in limit is stored as a "max longest side" on Parcel and Large parcel, so it can be edited.

**17. Multi-box items (open question, default chosen).** The variant weight is for the whole item,
so it is **split evenly across boxes** for the tier check. Each box uses the box dimensions. Freight
= tier cost × box count.

**18. Manual override (open question, default chosen).** `freight.override_cost` is treated as the
**total freight for one unit**, not multiplied by box count. An Admin can flip this with the
"Manual freight override is per box" setting. An override of $0 is respected. An override works
even when dimensions are missing.

**19. Rounding to a 9.** Round up to whole dollars, then up to the next amount ending in 9:
516 → 519, 519 → 519, 519.01 → 529, 520 → 529. Rounding applies after taking the higher of MAP and
the target-margin price, so MAP is never undercut.

**20. Thresholds.**
- Flagged means margin is *under* 20%, and critical means *under* 0%. So exactly 20% is OK, and
  exactly 0% is flagged but not critical.
- Reprice applies at an increase of 35% *or less*, and a freight surcharge at $150 *or less*.
- The price increase is measured against the rounded suggested price.

**21. Suggested fix only for flagged items.** OK items get "No change needed".
"Exclude from discounts" is added whenever margin at the max discount is below 0, even on an
otherwise OK item.

**22. Missing data.**
- A variant missing price, unit cost, or dimensions (with no override) can't be checked. It goes to
  Data health and is not flagged.
- Missing weight falls back to dimensional weight, with a warning on the math card.
- A box count that isn't a whole number of 1 or more falls back to 1, with a warning.
- Missing MAP doesn't block the check and is listed on Data health.
- Metafield values can be plain numbers, `dimension` JSON (unit converted to inches), or `money`
  JSON.

**23. Estimated monthly dollars lost.** For each critical variant: (landed cost − price) × net units
sold in the last 30 days, added up. Units come from ShopifyQL (`FROM sales SHOW net_items_sold GROUP
BY product_variant_id DURING last_30_days`) via `read_reports`. This is the loss against breaking
even, not the shortfall against the target margin. If the reports query fails, the dashboard says
"Not available" instead of guessing.

## Data

**24. Extra tables and columns.** Beyond the four required tables:
- `staff_member` holds roles.
- `data_issue` feeds Data health.
- `scan` gains status, bulk operation ID, result URL, resume point, lease, data-health summary,
  monthly loss, and error.
- `flag` keeps title, image, the money values in cents, and units sold, so the queue doesn't need
  Shopify to render.
- `audit_log` gains a `shop` column.
- `settings_version` stores each setting as a column, plus the tiers as JSON.

The Phase 2 `proposal` and `change` tables can link to `flag` and `audit_log` by ID.

**25. Audit log is append only, twice over.** The code has no update or delete paths for it, and a
database trigger rejects `UPDATE` and `DELETE` on `audit_log`.

**26. More editable settings.** "All values are editable", so these are settings too: the
dimensional weight divisor (139), the reprice limit (35%), the surcharge limit ($150), the max
discount (10%), and the override-per-box switch.

**27. Product detail shows the math twice.** First worked out live from today's Shopify data and
settings, then exactly as the last scan saw it (from the flag snapshot), because the two can differ.

**28. Prisma 6.** Kept the template's Prisma 6. Prisma 8 is still a release candidate.

**29. Prisma Postgres instead of Neon.** The kickoff named Neon; the production Vercel project was set
up with Prisma Postgres from the Vercel Marketplace instead (2026-11-17). Its integration names the
pooled string `DATABASE_URL_POOLED` and the direct one `DATABASE_URL`, so the Prisma schema reads
those names: the app uses the pooled one, `prisma migrate` uses the direct one.

**30. Uttermost price list from Dropbox.** Added 2026-11-18. The app downloads Uttermost's
`Uttermost Price List.xlsx` from a shared Dropbox *file* link (not the folder link: a folder link
returns a web page, not the file), with no Dropbox account or token. A daily cron at 12:00 UTC
(6am Central) and a **Check for new version** button download the file, compare its sha256 with
the stored versions, and import it only when it changed. Each import is a version with every column
kept (typed columns for item number, prices, MAP and shipping, the rest in `data`). The last six
versions are kept. It writes only to the app's own database, so Phase 1 stays read only. Showing
the data is all it does for now; MAP checks against Shopify come later.

**31. Screens must not export `config`.** On Vercel, a route that exports `config` (for example
`maxDuration`) is built into its own server bundle. React Router's route discovery (`/__manifest`)
runs in the main bundle and can't see routes in other bundles, so clicking an app link to such a
screen showed "404 Not Found" (the Dashboard and the Uttermost price list both did). Only API and
webhook routes, which the screens never link to, export `config`. `vercel.json` sets `"fluid": true`,
which gives every function 300 seconds by default, so screens still have time for slow work.
`app/routes.test.ts` enforces this.
