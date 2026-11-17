/**
 * The scan pipeline, built for serverless:
 *
 *   1. startScan()       starts a Shopify bulk query and returns right away.
 *   2. Shopify calls the bulk_operations/finish webhook when it's done.
 *   3. processScan()     streams the JSONL result and writes flags in batches.
 *                        It stops before the function time limit, records how
 *                        many lines it finished, and hands off to a fresh
 *                        invocation (/api/scan/continue) to carry on.
 *   4. finalizeScan()    adds units sold, totals, and the "scan finished" log.
 *
 * Bulk queries always run with the shop's offline token. Shopify doesn't send
 * bulk operation notifications for operations started with an online token.
 * The staff member who clicked "Run scan now" is still the logged actor.
 */
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { Prisma, Scan, ScanTrigger } from "@prisma/client";
import prisma from "../../db.server";
import { unauthenticated } from "../../shopify.server";
import { appendAudit, appendAuditMany, EVENT_TYPES, SYSTEM_ACTOR, type Actor, type AuditEntry } from "../audit.server";
import { evaluateVariant } from "../freight/engine";
import { getCurrentSettingsRow, rowToSettings } from "../settings.server";
import {
  ACTIVE_PRODUCTS_COUNT_QUERY,
  BULK_RUN_MUTATION,
  BULK_STATUS_QUERY,
  METAFIELDS,
  METAFIELD_DEFINITIONS_QUERY,
  UNITS_SOLD_QUERY,
  UNITS_SOLD_SHOPIFYQL,
  VARIANT_BULK_QUERY,
} from "./queries";
import { gidToId, parseVariantLine, type BulkVariantLine } from "./variant-line";

const BATCH_SIZE = Number(process.env.SCAN_BATCH_SIZE || 250);
/** Stop starting new batches after this long. Keep well under maxDuration. */
const TIME_BUDGET_MS = Number(process.env.SCAN_TIME_BUDGET_MS || 240_000);
/** A scan that has been RUNNING this long gets its bulk operation checked directly. */
const STALE_RUNNING_MS = 10 * 60_000;

type AdminClient = Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];

async function gql<T>(admin: AdminClient, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

// ---------------------------------------------------------------------------
// 1. Start
// ---------------------------------------------------------------------------

export class ScanAlreadyRunningError extends Error {
  constructor(public scan: Scan) {
    super("A scan is already running.");
  }
}

export async function activeScan(shop: string) {
  return prisma.scan.findFirst({
    where: { shop, status: { in: ["STARTING", "RUNNING", "PROCESSING"] } },
    orderBy: { startedAt: "desc" },
  });
}

export async function startScan(shop: string, trigger: ScanTrigger, actor: Actor) {
  const running = await activeScan(shop);
  if (running) throw new ScanAlreadyRunningError(running);

  const settingsRow = await getCurrentSettingsRow(shop);
  const scan = await prisma.scan.create({
    data: {
      shop,
      trigger,
      triggeredById: actor.id,
      triggeredByName: actor.name,
      settingsVersionId: settingsRow.id,
      status: "STARTING",
    },
  });
  await appendAudit({
    shop,
    actor,
    eventType: EVENT_TYPES.scanStarted,
    inputs: { scanId: scan.id, trigger, settingsVersionId: settingsRow.id },
  });

  try {
    const { admin } = await unauthenticated.admin(shop);
    const data = await gql<{
      bulkOperationRunQuery: {
        bulkOperation: { id: string; status: string } | null;
        userErrors: { field: string[] | null; message: string }[];
      };
    }>(admin, BULK_RUN_MUTATION, { query: VARIANT_BULK_QUERY });
    const { bulkOperation, userErrors } = data.bulkOperationRunQuery;
    if (!bulkOperation || userErrors.length) {
      throw new Error(userErrors.map((e) => e.message).join("; ") || "Bulk query was not created.");
    }
    return await prisma.scan.update({
      where: { id: scan.id },
      data: { bulkOperationId: bulkOperation.id, status: "RUNNING" },
    });
  } catch (e) {
    await failScan(scan, e);
    throw e;
  }
}

async function failScan(scan: Pick<Scan, "id" | "shop">, e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  await prisma.scan.update({
    where: { id: scan.id },
    data: { status: "FAILED", finishedAt: new Date(), error: message.slice(0, 2000), leaseUntil: null },
  });
  await appendAudit({
    shop: scan.shop,
    actor: SYSTEM_ACTOR,
    eventType: EVENT_TYPES.scanFailed,
    inputs: { scanId: scan.id },
    after: { error: message.slice(0, 2000) },
  });
}

// ---------------------------------------------------------------------------
// 2. Bulk operation finished (webhook, or found by the safety net)
// ---------------------------------------------------------------------------

/**
 * Moves a scan from RUNNING to PROCESSING when its bulk operation is done.
 * Returns the scan id to process, or null if there's nothing to do.
 * Safe to call more than once for the same operation.
 */
export async function onBulkOperationFinished(
  bulkOperationId: string,
  status: string,
  errorCode?: string | null,
): Promise<number | null> {
  const scan = await prisma.scan.findUnique({ where: { bulkOperationId } });
  if (!scan || scan.status !== "RUNNING") return null;

  if (status.toUpperCase() !== "COMPLETED") {
    await failScan(scan, new Error(`Bulk query ended with status ${status}${errorCode ? ` (${errorCode})` : ""}.`));
    return null;
  }
  const claimed = await prisma.scan.updateMany({
    where: { id: scan.id, status: "RUNNING" },
    data: { status: "PROCESSING" },
  });
  return claimed.count === 1 ? scan.id : null;
}

/** Checks a RUNNING scan's bulk operation directly, in case a webhook was missed. */
export async function reconcileRunningScan(scan: Scan): Promise<number | null> {
  if (scan.status !== "RUNNING" || !scan.bulkOperationId) return null;
  const { admin } = await unauthenticated.admin(scan.shop);
  const data = await gql<{ bulkOperation: { status: string; errorCode: string | null } | null }>(
    admin,
    BULK_STATUS_QUERY,
    { id: scan.bulkOperationId },
  );
  const op = data.bulkOperation;
  if (!op) {
    await failScan(scan, new Error("Shopify no longer knows this bulk operation."));
    return null;
  }
  if (["CREATED", "RUNNING", "CANCELING"].includes(op.status)) return null;
  return onBulkOperationFinished(scan.bulkOperationId, op.status, op.errorCode);
}

// ---------------------------------------------------------------------------
// 3. Process the result in chunks
// ---------------------------------------------------------------------------

export type ProcessOutcome = "finished" | "continue" | "busy" | "failed";

export async function processScan(scanId: number, budgetMs = TIME_BUDGET_MS): Promise<ProcessOutcome> {
  const started = Date.now();
  const leaseMs = budgetMs + 90_000;
  const claimed = await prisma.scan.updateMany({
    where: {
      id: scanId,
      status: "PROCESSING",
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
    },
    data: { leaseUntil: new Date(Date.now() + leaseMs) },
  });
  if (claimed.count === 0) return "busy";

  let scan = await prisma.scan.findUniqueOrThrow({ where: { id: scanId }, include: { settingsVersion: true } });
  try {
    const settings = rowToSettings(scan.settingsVersion);
    const { admin } = await unauthenticated.admin(scan.shop);

    if (!scan.resultUrl) {
      const data = await gql<{
        bulkOperation: { url: string | null; partialDataUrl: string | null; objectCount: string } | null;
      }>(admin, BULK_STATUS_QUERY, { id: scan.bulkOperationId });
      const url = data.bulkOperation?.url ?? null;
      if (!url) {
        // No variants matched (empty store), so there's nothing to download.
        await finalizeScan(scan.id, admin);
        return "finished";
      }
      scan = { ...scan, ...(await prisma.scan.update({ where: { id: scan.id }, data: { resultUrl: url } })) };
    }

    const res = await fetch(scan.resultUrl!);
    if (!res.ok || !res.body) throw new Error(`Could not download scan results (HTTP ${res.status}).`);
    const rl = createInterface({
      input: Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
      crlfDelay: Infinity,
    });

    let lineNo = 0;
    let batch: string[] = [];
    let outOfTime = false;
    for await (const text of rl) {
      lineNo++;
      if (lineNo <= scan.linesProcessed) continue; // done by an earlier invocation
      if (!text.trim()) {
        batch.push("");
      } else {
        batch.push(text);
      }
      if (batch.length >= BATCH_SIZE) {
        await writeBatch(scan, settings, batch);
        scan.linesProcessed += batch.length;
        batch = [];
        if (Date.now() - started > budgetMs) {
          outOfTime = true;
          break;
        }
      }
    }
    rl.close();
    if (!outOfTime && batch.length) {
      await writeBatch(scan, settings, batch);
      scan.linesProcessed += batch.length;
    }

    if (outOfTime) {
      await prisma.scan.update({ where: { id: scan.id }, data: { leaseUntil: null } });
      await requestContinuation(scan.id);
      return "continue";
    }

    await finalizeScan(scan.id, admin);
    return "finished";
  } catch (e) {
    await failScan(scan, e);
    return "failed";
  }
}

type Settings = ReturnType<typeof rowToSettings>;

/**
 * Evaluates one batch of JSONL lines and writes flags, data issues, log rows
 * and the new resume point in a single transaction, so a crash can never
 * leave a half-written batch behind.
 */
async function writeBatch(scan: Scan, settings: Settings, lines: string[]) {
  const flags: Prisma.FlagCreateManyInput[] = [];
  const issues: Prisma.DataIssueCreateManyInput[] = [];
  const audits: AuditEntry[] = [];
  let variants = 0;

  for (const text of lines) {
    if (!text) continue;
    const parsed = parseVariantLine(JSON.parse(text) as BulkVariantLine);
    if (!parsed || !parsed.requiresShipping) continue;
    variants++;

    const r = evaluateVariant(parsed.inputs, settings);
    const hasMap = parsed.inputs.map != null && parsed.inputs.map > 0;
    if (r.status === "incomplete" || !hasMap) {
      issues.push({
        scanId: scan.id,
        productId: parsed.productId,
        variantId: parsed.variantId,
        productTitle: parsed.productTitle,
        variantTitle: parsed.variantTitle,
        missing: r.status === "incomplete" ? r.missing : [],
        hasMap,
      });
    }
    if (r.status !== "complete" || r.severity === "ok") continue;

    const snapshot = {
      settingsVersionId: scan.settingsVersionId,
      sku: parsed.sku,
      inputs: parsed.inputs,
      rawMetafields: parsed.rawMetafields,
      freight: r.freight,
      warnings: r.warnings,
      lines: r.lines,
      suggestedPriceCents: r.suggestedPriceCents,
      priceIncreasePct: r.priceIncreasePct,
      suggestedSurchargeCents: r.suggestedSurchargeCents,
      marginCents: r.marginCents,
      marginAtDiscountCents: r.marginAtDiscountCents,
      discountPriceCents: r.discountPriceCents,
    } as unknown as Prisma.InputJsonValue;

    flags.push({
      scanId: scan.id,
      productId: parsed.productId,
      variantId: parsed.variantId,
      productTitle: parsed.productTitle,
      variantTitle: parsed.variantTitle,
      imageUrl: parsed.imageUrl,
      tier: r.freight.tierName,
      snapshot,
      priceCents: r.priceCents,
      unitCostCents: r.unitCostCents,
      freightCents: r.freight.totalCents,
      landedCostCents: r.landedCostCents,
      marginPct: r.marginPct,
      marginAtDiscountPct: Number.isFinite(r.marginAtDiscountPct) ? r.marginAtDiscountPct : -9999,
      severity: r.severity === "critical" ? "CRITICAL" : "FLAGGED",
      suggestedFix: r.suggestedFix,
      excludeFromDiscounts: r.excludeFromDiscounts,
      suggestedValueCents: r.suggestedValueCents,
    });
    audits.push({
      shop: scan.shop,
      actor: SYSTEM_ACTOR,
      eventType: EVENT_TYPES.flagWritten,
      productId: parsed.productId,
      after: {
        scanId: scan.id,
        variantId: parsed.variantId,
        severity: r.severity,
        marginPct: r.marginPct,
        landedCostCents: r.landedCostCents,
        suggestedFix: r.suggestedFix,
        excludeFromDiscounts: r.excludeFromDiscounts,
        suggestedValueCents: r.suggestedValueCents,
      },
      inputs: { ...parsed.inputs, settingsVersionId: scan.settingsVersionId } as unknown as Prisma.InputJsonValue,
    });
  }

  await prisma.$transaction(async (tx) => {
    if (flags.length) await tx.flag.createMany({ data: flags, skipDuplicates: true });
    if (issues.length) await tx.dataIssue.createMany({ data: issues, skipDuplicates: true });
    await appendAuditMany(audits, tx);
    await tx.scan.update({
      where: { id: scan.id },
      data: {
        linesProcessed: { increment: lines.length },
        variantsScanned: { increment: variants },
        flagsFound: { increment: flags.length },
      },
    });
  });
}

/** Asks a fresh function invocation to carry on processing. */
async function requestContinuation(scanId: number) {
  const base = process.env.SHOPIFY_APP_URL;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) {
    console.warn("SHOPIFY_APP_URL or CRON_SECRET missing; the nightly cron will resume this scan.");
    return;
  }
  try {
    await fetch(new URL("/api/scan/continue", base), {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ scanId }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.warn("Continuation request failed; the cron safety net will resume.", e);
  }
}

// ---------------------------------------------------------------------------
// 4. Finalize
// ---------------------------------------------------------------------------

async function finalizeScan(scanId: number, admin: AdminClient) {
  const scan = await prisma.scan.findUniqueOrThrow({ where: { id: scanId } });

  // Products scanned: active products in the store.
  let productsScanned = 0;
  try {
    const d = await gql<{ productsCount: { count: number } | null }>(admin, ACTIVE_PRODUCTS_COUNT_QUERY);
    productsScanned = d.productsCount?.count ?? 0;
  } catch (e) {
    console.warn("productsCount failed", e);
  }

  // Units sold in the last 30 days, for the estimated monthly loss.
  const units = await unitsSoldLast30Days(admin);
  let monthlyLossCents: number | null = null;
  if (units) {
    const flags = await prisma.flag.findMany({
      where: { scanId },
      select: { id: true, variantId: true, priceCents: true, landedCostCents: true },
    });
    monthlyLossCents = 0;
    const updates: Prisma.PrismaPromise<unknown>[] = [];
    for (const f of flags) {
      const u = units.get(gidToId(f.variantId)) ?? 0;
      updates.push(prisma.flag.update({ where: { id: f.id }, data: { unitsSold30d: u } }));
      const lossPerUnit = Math.max(0, f.landedCostCents - f.priceCents);
      monthlyLossCents += lossPerUnit * Math.max(0, u);
    }
    for (let i = 0; i < updates.length; i += 200) await prisma.$transaction(updates.slice(i, i + 200));
  }

  // Data health: which metafield definitions exist, and counts of gaps.
  const dataHealth = await buildDataHealth(scanId, admin);

  await prisma.scan.update({
    where: { id: scanId },
    data: {
      status: "FINISHED",
      finishedAt: new Date(),
      productsScanned,
      monthlyLossCents,
      dataHealth: dataHealth as unknown as Prisma.InputJsonValue,
      leaseUntil: null,
    },
  });
  const final = await prisma.scan.findUniqueOrThrow({ where: { id: scanId } });
  await appendAudit({
    shop: scan.shop,
    actor: SYSTEM_ACTOR,
    eventType: EVENT_TYPES.scanFinished,
    inputs: { scanId, settingsVersionId: scan.settingsVersionId, trigger: scan.trigger },
    after: {
      productsScanned: final.productsScanned,
      variantsScanned: final.variantsScanned,
      flagsFound: final.flagsFound,
      monthlyLossCents: final.monthlyLossCents,
    },
  });
}

async function unitsSoldLast30Days(admin: AdminClient): Promise<Map<string, number> | null> {
  try {
    const d = await gql<{
      shopifyqlQuery: {
        tableData: { columns: { name: string }[]; rows: Record<string, string | number>[] } | null;
        parseErrors: string[];
      } | null;
    }>(admin, UNITS_SOLD_QUERY, { q: UNITS_SOLD_SHOPIFYQL });
    const t = d.shopifyqlQuery?.tableData;
    if (!t || d.shopifyqlQuery?.parseErrors?.length) {
      console.warn("ShopifyQL units sold failed", d.shopifyqlQuery?.parseErrors);
      return null;
    }
    const map = new Map<string, number>();
    for (const row of t.rows) {
      const id = String(row.product_variant_id ?? "");
      if (!id) continue;
      map.set(gidToId(id), Number(row.net_items_sold) || 0);
    }
    return map;
  } catch (e) {
    console.warn("ShopifyQL units sold failed", e);
    return null;
  }
}

export interface DataHealthSummary {
  /** Metafields the app reads that have no definition in Shopify yet. */
  missingDefinitions: string[];
  /** Definitions that exist, with their Shopify type. */
  definitions: { key: string; type: string }[];
  counts: { missingCost: number; missingDimensions: number; missingPrice: number; missingMap: number };
  definitionsError?: string;
}

async function buildDataHealth(scanId: number, admin: AdminClient): Promise<DataHealthSummary> {
  const [missingCost, missingDimensions, missingPrice, missingMap] = await Promise.all([
    prisma.dataIssue.count({ where: { scanId, missing: { has: "unit_cost" } } }),
    prisma.dataIssue.count({ where: { scanId, missing: { has: "dimensions" } } }),
    prisma.dataIssue.count({ where: { scanId, missing: { has: "price" } } }),
    prisma.dataIssue.count({ where: { scanId, hasMap: false } }),
  ]);
  const wanted = METAFIELDS.map(([, ns, key]) => `${ns}.${key}`);
  try {
    type Defs = { nodes: { namespace: string; key: string; type: { name: string } }[] };
    const d = await gql<{ freight: Defs; pricing: Defs }>(admin, METAFIELD_DEFINITIONS_QUERY);
    const have = [...d.freight.nodes, ...d.pricing.nodes].map((n) => ({
      key: `${n.namespace}.${n.key}`,
      type: n.type.name,
    }));
    const haveKeys = new Set(have.map((h) => h.key));
    return {
      missingDefinitions: wanted.filter((k) => !haveKeys.has(k)),
      definitions: have.filter((h) => wanted.includes(h.key)),
      counts: { missingCost, missingDimensions, missingPrice, missingMap },
    };
  } catch (e) {
    return {
      missingDefinitions: [],
      definitions: [],
      counts: { missingCost, missingDimensions, missingPrice, missingMap },
      definitionsError: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------------------------------------------------------------------------
// Safety net, run by the nightly cron
// ---------------------------------------------------------------------------

/** Resumes scans whose webhook was missed or whose worker died. */
export async function recoverStuckScans(shop: string): Promise<number[]> {
  const toProcess: number[] = [];
  const stuck = await prisma.scan.findMany({
    where: { shop, status: { in: ["STARTING", "RUNNING", "PROCESSING"] } },
  });
  for (const s of stuck) {
    if (s.status === "STARTING" && Date.now() - s.startedAt.getTime() > STALE_RUNNING_MS) {
      // The function died between creating the row and starting the bulk query.
      await failScan(s, new Error("Scan never started its bulk query."));
      continue;
    }
    if (s.status === "RUNNING" && Date.now() - s.startedAt.getTime() > STALE_RUNNING_MS) {
      const id = await reconcileRunningScan(s).catch(() => null);
      if (id) toProcess.push(id);
    }
    if (s.status === "PROCESSING" && (!s.leaseUntil || s.leaseUntil < new Date())) {
      toProcess.push(s.id);
    }
  }
  return toProcess;
}

/** Shops that have installed the app (have an offline token). */
export async function installedShops(): Promise<string[]> {
  const rows = await prisma.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
  });
  return rows.map((r) => r.shop);
}
