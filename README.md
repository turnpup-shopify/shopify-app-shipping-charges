# Freight Margin Guard

An embedded Shopify app for HTGT Furniture. It finds products that lose money once freight is paid,
and shows the math in plain words.

**Phase 1 is read only.** The app's scopes are `read_products`, `read_inventory` and `read_reports`.
Nothing in the code writes to products, prices, tags, shipping or channels. Suggested fixes are
suggestions only.

- **Setup steps you do by hand:** [SETUP-CHECKLIST.md](SETUP-CHECKLIST.md)
- **Where the build differs from the kickoff, and why:** [DECISIONS.md](DECISIONS.md)

## Screens

| Screen | What it shows |
| --- | --- |
| Dashboard | Critical and flagged counts, estimated monthly dollars lost, last scan, **Run scan now** |
| Flag queue | Every flagged variant. Sort and filter on every column, export to CSV |
| Product detail | A receipt-style math card (live, and as the last scan saw it), plus that product's log history |
| Activity log | Newest first. Filter by person, product, event and date. Export to CSV |
| Settings | Every number in the freight model. Admin only, a reason is required, and it shows who changed each setting last. Also team roles |
| Data health | Missing metafield definitions, and variants missing cost, dimensions, price or MAP |
| Uttermost price list | The latest Uttermost price list from Dropbox: search and filter every item, see past versions, **Check for new version**. Admins set the Dropbox file link |

Every number can be clicked to show how it was worked out. The UI is built only from Polaris web
components, so it follows the admin's light or dark theme.

## How a scan works

```
Vercel Cron 08:00 UTC ──► GET /api/cron/scan ──► bulkOperationRunQuery (offline token) ──► returns
"Run scan now" ─────────► dashboard action ──┘

Shopify ──► POST /webhooks/bulk_operations/finish ──► replies at once, then waitUntil(processScan)
processScan: stream JSONL → evaluate → write flags + data gaps + log rows + resume point per batch
             └─ close to the time limit? → POST /api/scan/continue → next invocation resumes
finalizeScan: units sold (ShopifyQL) → monthly loss → data health → "scan finished" log row
```

The freight and margin math is in `app/lib/freight/engine.ts`. It is pure functions, with no
Shopify or database code, so it is easy to test and read.

## Project layout

```
app/lib/freight/      engine.ts (math), settings.ts (defaults), parse.ts (Shopify values)
app/lib/scan/         queries.ts (GraphQL), scan.server.ts (pipeline), variant-line.ts
app/lib/              audit.server.ts (append-only log), staff.server.ts (roles), settings.server.ts
app/routes/           app.*.tsx screens, api.cron.scan.tsx, api.scan.continue.tsx, webhooks.*.tsx
prisma/               schema.prisma, migrations/
vercel.json           build command and cron schedule
```

## Environment variables

See [`.env.example`](.env.example).

| Name | Where it comes from |
| --- | --- |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | The app's Client ID and secret in the Dev Dashboard |
| `SHOPIFY_APP_URL` | The environment's fixed domain, `https://…`, with no trailing slash |
| `SCOPES` | `read_products,read_inventory,read_reports` |
| `DATABASE_URL_POOLED` | Prisma Postgres **pooled** connection string. The app uses it at runtime. Added by the Vercel Prisma Postgres integration |
| `DATABASE_URL` | Prisma Postgres **direct** connection string. `prisma migrate` uses it. Added by the integration |
| `CRON_SECRET` | A long random string. Vercel Cron sends it automatically; it also protects `/api/scan/continue` |
| `SCAN_TIME_BUDGET_MS` | Optional, default `240000`. Keep it about 60s under the 300s function limit |

## Local setup

Requires Node 22.12+ and Shopify CLI 5+.

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in `.env`. Use a separate dev database (not production) for `DATABASE_URL_POOLED` and `DATABASE_URL`. Then:

```bash
npx prisma migrate deploy
```

```bash
npm test
```

```bash
npm run typecheck
```

To run the app inside Shopify admin locally, use a **separate dev app**, not staging or production.
`shopify app dev` rewrites the app's URLs to a tunnel. Create a third app in the Dev Dashboard, link
it as config `dev`, and run:

```bash
shopify app dev --config dev
```

The bulk-finish webhook may not reach a local tunnel reliably. The dashboard checks a running scan
directly after 2 minutes, so local scans still complete.

### Tests

- `npm test` runs the unit tests: every formula, the spec's mirror example, tier boundaries,
  missing data, overrides, multi-box items, parsing, CSV, and the queue's sort and filter.
- The scan pipeline integration test needs a Postgres database with migrations applied. It is
  skipped unless `TEST_DATABASE_URL` is set. It runs a full scan with Shopify mocked: chunked
  hand-off, resuming, duplicate webhooks, monthly loss, and the append-only log.

```bash
TEST_DATABASE_URL="postgresql://…" npx vitest run app/lib/scan/scan.integration.test.ts
```

## Deploying

There are two Vercel projects from one repo (see SETUP-CHECKLIST.md):

| Environment | Branch | Vercel project |
| --- | --- | --- |
| Staging | `staging` | `freight-margin-guard-staging` |
| Production | `main` | `freight-margin-guard` |

Pushing to a branch deploys it. The build runs `prisma generate`, then `prisma migrate deploy`
(over the direct connection), then `react-router build`. With the `@vercel/react-router` preset,
the scan routes get `maxDuration: 300`.

Shopify app config (scopes, webhooks, URLs) is deployed separately with Shopify CLI:

```bash
shopify app deploy --config staging
```

To automate that from CI later, create a service account token with the App development
permission, and set it as `SHOPIFY_SERVICE_ACCOUNT_TOKEN` in the CI job (DECISIONS.md #6).

### Triggering the cron by hand

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/scan
```
