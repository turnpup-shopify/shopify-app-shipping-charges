/**
 * End-to-end test of the scan pipeline against a real Postgres database, with
 * Shopify mocked. Skipped unless TEST_DATABASE_URL is set, because it needs a
 * database with migrations applied. See README "Running the integration test".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const DB = process.env.TEST_DATABASE_URL;
if (DB) {
  // Small batches so the test exercises hand-off between invocations.
  process.env.SCAN_BATCH_SIZE = "5";
  process.env.DATABASE_URL = DB;
  process.env.DATABASE_URL_UNPOOLED = DB;
}

const RESULT_URL = "https://storage.example/bulk-result.jsonl";
const SHOP = "test-shop.myshopify.com";

// --- Fake Shopify ----------------------------------------------------------
const variant = (n: number, o: Record<string, unknown> = {}) => ({
  id: `gid://shopify/ProductVariant/${n}`,
  title: "Default Title",
  sku: `SKU-${n}`,
  price: "100.00",
  compareAtPrice: null,
  product: { id: `gid://shopify/Product/${n}`, title: `Product ${n}`, status: "ACTIVE", featuredMedia: null },
  inventoryItem: { requiresShipping: true, unitCost: { amount: "40" }, measurement: { weight: { value: 10, unit: "POUNDS" } } },
  boxLength: { value: "20" },
  boxWidth: { value: "10" },
  boxHeight: { value: "10" },
  boxCount: null,
  overrideCost: null,
  map: { value: "90" },
  ...o,
});

const LINES = [
  // 1: the mirror from the spec → critical, surcharge
  variant(1, {
    price: "328.00",
    inventoryItem: { requiresShipping: true, unitCost: { amount: "137" }, measurement: { weight: { value: 60, unit: "POUNDS" } } },
    boxLength: { value: "110" },
    boxWidth: { value: "40" },
    boxHeight: { value: "4" },
    map: null,
  }),
  // 2: healthy
  variant(2),
  // 3: missing unit cost → data issue only
  variant(3, { inventoryItem: { requiresShipping: true, unitCost: null, measurement: null } }),
  // 4: doesn't ship → ignored
  variant(4, { inventoryItem: { requiresShipping: false, unitCost: { amount: "1" }, measurement: null } }),
  // 5..12: flagged (landed 85 on a $100 price → 15%)
  ...Array.from({ length: 8 }, (_, i) =>
    variant(5 + i, { inventoryItem: { requiresShipping: true, unitCost: { amount: "60" }, measurement: { weight: { value: 10, unit: "POUNDS" } } } }),
  ),
].map((l) => JSON.stringify(l));

let opCounter = 0;
const graphql = vi.fn(async (query: string) => {
  const body = (data: unknown) => new Response(JSON.stringify({ data }));
  if (query.includes("bulkOperationRunQuery"))
    return body({ bulkOperationRunQuery: { bulkOperation: { id: `gid://shopify/BulkOperation/${++opCounter}`, status: "CREATED" }, userErrors: [] } });
  if (query.includes("ScanBulkStatus"))
    return body({ bulkOperation: { id: "gid://shopify/BulkOperation/1", status: "COMPLETED", errorCode: null, objectCount: String(LINES.length), url: RESULT_URL, partialDataUrl: null } });
  if (query.includes("productsCount")) return body({ productsCount: { count: 12 } });
  if (query.includes("metafieldDefinitions"))
    return body({
      freight: { nodes: [{ namespace: "freight", key: "box_length", name: "L", type: { name: "number_decimal" } }] },
      pricing: { nodes: [] },
    });
  if (query.includes("shopifyqlQuery"))
    return body({
      shopifyqlQuery: {
        tableData: { columns: [], rows: [{ product_variant_id: "gid://shopify/ProductVariant/1", net_items_sold: "4" }] },
        parseErrors: [],
      },
    });
  throw new Error(`unexpected query ${query.slice(0, 60)}`);
});

vi.mock("../../shopify.server", () => ({
  unauthenticated: { admin: async () => ({ admin: { graphql } }) },
}));

const realFetch = globalThis.fetch;
const continuations: number[] = [];

describe.skipIf(!DB)("scan pipeline (integration)", () => {
  let prisma: typeof import("../../db.server").default;
  let scan: typeof import("./scan.server");

  beforeAll(async () => {
    process.env.SHOPIFY_APP_URL = "https://app.example";
    process.env.CRON_SECRET = "test-secret";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === RESULT_URL) return new Response(LINES.join("\n") + "\n");
      if (url.endsWith("/api/scan/continue")) {
        continuations.push(JSON.parse(String(init?.body)).scanId);
        return new Response(null, { status: 202 });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    prisma = (await import("../../db.server")).default;
    scan = await import("./scan.server");
    await prisma.$executeRawUnsafe(
      `TRUNCATE "flag", "data_issue", "scan", "settings_version", "staff_member" RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await prisma?.$disconnect();
  });

  it("runs a scan end to end, in chunks, and resumes by line", async () => {
    const actor = { id: "123", name: "Pat Admin" };
    const started = await scan.startScan(SHOP, "MANUAL", actor);
    expect(started.status).toBe("RUNNING");
    await expect(scan.startScan(SHOP, "CRON", { id: "system", name: "System" })).rejects.toThrow(/already running/);

    // Webhook arrives twice; only the first claims the scan.
    const id = await scan.onBulkOperationFinished("gid://shopify/BulkOperation/1", "completed");
    expect(await scan.onBulkOperationFinished("gid://shopify/BulkOperation/1", "completed")).toBeNull();
    expect(id).toBe(started.id);

    // A zero time budget forces a hand-off after the first batch of 5 lines.
    expect(await scan.processScan(id!, 0)).toBe("continue");
    expect(continuations).toEqual([id]);
    const mid = await prisma.scan.findUniqueOrThrow({ where: { id: id! } });
    expect(mid.linesProcessed).toBe(5);
    expect(mid.leaseUntil).toBeNull();
    // The next invocation picks up at line 6 and finishes.
    expect(await scan.processScan(id!, 60_000)).toBe("finished");

    const s = await prisma.scan.findUniqueOrThrow({ where: { id: id! } });
    expect(s.status).toBe("FINISHED");
    expect(s.linesProcessed).toBe(LINES.length);
    expect(s.variantsScanned).toBe(11); // 12 lines minus the one that doesn't ship
    expect(s.flagsFound).toBe(9); // mirror + 8 flagged
    expect(s.productsScanned).toBe(12);
    // Mirror loses $59.00 per unit × 4 sold.
    expect(s.monthlyLossCents).toBe(5900 * 4);

    const mirror = await prisma.flag.findFirstOrThrow({ where: { scanId: id!, variantId: "gid://shopify/ProductVariant/1" } });
    expect(mirror.severity).toBe("CRITICAL");
    expect(mirror.landedCostCents).toBe(38700);
    expect(mirror.suggestedFix).toBe("surcharge");
    expect(mirror.suggestedValueCents).toBe(14100);
    expect(mirror.excludeFromDiscounts).toBe(true);
    expect(mirror.unitsSold30d).toBe(4);

    const issue = await prisma.dataIssue.findFirstOrThrow({ where: { scanId: id!, variantId: "gid://shopify/ProductVariant/3" } });
    expect(issue.missing).toEqual(["unit_cost"]);

    const health = s.dataHealth as { missingDefinitions: string[] };
    expect(health.missingDefinitions).toContain("pricing.map");
    expect(health.missingDefinitions).not.toContain("freight.box_length");

    const audit = await prisma.auditLog.groupBy({
      by: ["eventType"],
      where: { shop: SHOP, inputs: { path: ["scanId"], equals: id! } },
      _count: true,
    });
    const counts = Object.fromEntries(audit.map((a) => [a.eventType, a._count]));
    expect(counts.scan_started).toBe(1);
    expect(counts.scan_finished).toBe(1);
    const flagLogs = await prisma.auditLog.count({ where: { shop: SHOP, eventType: "flag_written", after: { path: ["scanId"], equals: id! } } });
    expect(flagLogs).toBe(9);
    const startedLog = await prisma.auditLog.findFirstOrThrow({ where: { shop: SHOP, eventType: "scan_started", inputs: { path: ["scanId"], equals: id! } } });
    expect(startedLog.actorName).toBe("Pat Admin");

    // Processing a finished scan again does nothing.
    expect(await scan.processScan(id!)).toBe("busy");
  });

  it("resumes from the recorded line without duplicating flags", async () => {
    const actor = { id: "system", name: "System" };
    graphql.mockClear();
    const s2 = await scan.startScan(SHOP, "CRON", actor);
    expect(s2.bulkOperationId).toBe("gid://shopify/BulkOperation/2");
    const id = await scan.onBulkOperationFinished("gid://shopify/BulkOperation/2", "completed");
    // Pretend an earlier invocation finished the first 5 lines and died.
    await prisma.scan.update({ where: { id: id! }, data: { linesProcessed: 5 } });
    expect(await scan.processScan(id!, 60_000)).toBe("finished");
    const s = await prisma.scan.findUniqueOrThrow({ where: { id: id! } });
    expect(s.linesProcessed).toBe(LINES.length);
    // Lines 1-5 were skipped: mirror (1) and flagged #5 are not re-evaluated here.
    expect(s.flagsFound).toBe(7);
  });

  it("refuses to update or delete audit rows", async () => {
    await expect(prisma.$executeRawUnsafe(`UPDATE "audit_log" SET actor_name = 'x'`)).rejects.toThrow(/append only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "audit_log"`)).rejects.toThrow(/append only/);
  });
});
