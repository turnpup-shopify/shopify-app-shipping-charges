# What you need to do by hand

Do these in order. Everything else is in the repo. Steps marked **(both)** are done once for
staging and once for production.

## 1. GitHub

1. Create a private repo, for example `freight-margin-guard`, and push this folder to `main`.
2. Create a `staging` branch from `main` and push it.

## 2. Neon and Vercel (both)

Create two Vercel projects from the same repo. See DECISIONS.md #3 for why it's two.

| | Staging | Production |
| --- | --- | --- |
| Project name | `freight-margin-guard-staging` | `freight-margin-guard` |
| Production branch | `staging` | `main` |
| Domain | your fixed staging domain, e.g. `freight-guard-staging.htgtfurniture.com` | your production domain |

For each project:

1. Vercel → Add New → Project → import the repo. The framework is detected as React Router.
2. Settings → Git → set **Production Branch** as in the table.
3. Settings → Domains → add the domain from the table.
4. Storage (Marketplace) → **Neon** → create a database for this project. Vercel adds
   `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct) for you. Use a separate Neon
   database or branch for each project.
5. Settings → Environment Variables (Production environment), add:
   - `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`: from step 3 below
   - `SHOPIFY_APP_URL`: `https://<this project's domain>`, with no trailing slash
   - `SCOPES`: `read_products,read_inventory,read_reports`
   - `CRON_SECRET`: a long random string. Generate one with `openssl rand -hex 32`.
6. Note your plan (Hobby or Pro). Both work: the scan routes use a 300s limit.

## 3. Shopify Dev Dashboard (both)

Create the apps **from the HTGT store's own organization**, not a Partner organization
(DECISIONS.md #2). This avoids the IP allowlist rule that starts 2026-11-20.

1. Dev Dashboard → Create app → "Freight Margin Guard (Staging)" or "Freight Margin Guard".
2. Copy the Client ID and secret into that Vercel project's env vars (step 2.5), then redeploy.
3. On your machine, link the app config. This needs a browser login:

   ```bash
   shopify app config link
   ```

   Pick the app, and name the config `staging` or `production`. This creates
   `shopify.app.staging.toml` or `shopify.app.production.toml`.
4. In that new file, set:
   - `application_url = "https://<domain>"`
   - `redirect_urls = [ "https://<domain>/auth/callback" ]`
   - `automatically_update_urls_on_dev = false` (staging and production only)

   Keep `[access_scopes]` and `[webhooks]` the same as `shopify.app.toml`.
5. Deploy the config, which registers scopes and webhooks:

   ```bash
   shopify app deploy --config staging
   ```

6. Commit the new `.toml` file.

## 4. Install on the HTGT store (both)

1. In the Dev Dashboard, open the app → **Installs** → install on the HTGT store.
2. Open the app in Shopify admin. **The first person to open it becomes Admin**, so make sure it's
   you.
3. On the dashboard, click **Run scan now**. A few minutes later the flag queue fills in.

## 5. Metafields (only if Data health says some are missing)

The app reads these variant metafields but doesn't create them in Phase 1. If Data health lists any
as missing, create the definitions in Shopify admin → Settings → Custom data → Variants:

| Metafield | Suggested type |
| --- | --- |
| `freight.box_length` | Decimal (inches) |
| `freight.box_width` | Decimal (inches) |
| `freight.box_height` | Decimal (inches) |
| `freight.box_count` | Integer |
| `freight.override_cost` | Decimal or Money |
| `pricing.map` | Decimal or Money |

## 6. Confirm two open questions

The current defaults are below. Each one is a single setting or a single line to change.

1. **Is `freight.override_cost` per box or for the whole item?** The default is the whole item.
   An Admin can change this on the Settings screen.
2. **For multi-box items, is the variant weight the total?** The default treats it as the total and
   splits it evenly across boxes.
