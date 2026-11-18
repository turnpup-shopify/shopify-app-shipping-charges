# Freight Margin Guard

Embedded Shopify app (React Router template, Polaris web components, Prisma/Postgres, Vercel).
Read README.md and DECISIONS.md first.

- Phase 1 is read only, with one exception: `write_shipping`, used only to move variants in or out
  of the Freight shipping profile when a person clicks a button (app/lib/shipping, DECISIONS #32).
  Never add another `write_` scope or any other mutation that changes store data.
- The freight math lives in `app/lib/freight/engine.ts` as pure functions. Change it test-first
  (`npm test`).
- `audit_log` is append only. Never add update or delete code for it.
- Use the Shopify AI Toolkit to check Admin GraphQL before changing queries in `app/lib/scan/queries.ts`.
