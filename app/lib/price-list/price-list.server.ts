/**
 * Downloads the Uttermost price list from Dropbox and stores it as a new
 * version when the file has changed. Writes only to this app's own database;
 * nothing here touches Shopify.
 */
import { createHash } from "node:crypto";
import { Prisma, type ScanTrigger } from "@prisma/client";
import prisma from "../../db.server";
import { appendAudit, EVENT_TYPES, type Actor } from "../audit.server";
import { parsePriceList } from "./parse";
import { DEFAULT_PRICE_LIST_URL, fileNameFromUrl, KEEP_VERSIONS, looksLikeXlsx, toDownloadUrl } from "./source";
const DOWNLOAD_TIMEOUT_MS = 60_000;
const INSERT_CHUNK = 1000;

export type CheckResult =
  | { status: "imported"; importId: number; rowCount: number }
  | { status: "unchanged"; importId: number }
  | { status: "failed"; error: string };

/** The link to check for a shop: the saved one, or the default. */
export async function priceListUrl(shop: string): Promise<string> {
  const source = await prisma.priceListSource.findUnique({ where: { shop } });
  return source?.url ?? DEFAULT_PRICE_LIST_URL;
}

/** Saves a new Dropbox link for the shop. Throws PriceListUrlError if it's not a file link. */
export async function savePriceListUrl(shop: string, actor: Actor, url: string) {
  toDownloadUrl(url); // validate
  const before = await priceListUrl(shop);
  const trimmed = url.trim();
  await prisma.priceListSource.upsert({
    where: { shop },
    create: { shop, url: trimmed, updatedById: actor.id, updatedByName: actor.name },
    update: { url: trimmed, updatedById: actor.id, updatedByName: actor.name },
  });
  await appendAudit({
    shop,
    actor,
    eventType: EVENT_TYPES.priceListSourceChanged,
    before: { url: before },
    after: { url: trimmed },
  });
}

/**
 * Downloads the file. With `knownEtag`, Dropbox answers 304 Not Modified when
 * the file hasn't changed, so an unchanged day downloads nothing.
 */
async function download(
  url: string,
  knownEtag: string | null,
): Promise<{ notModified: true } | { notModified: false; bytes: Uint8Array; etag: string | null }> {
  const res = await fetch(toDownloadUrl(url), {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; FreightMarginGuard/1.0)",
      ...(knownEtag ? { "If-None-Match": knownEtag } : {}),
    },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (res.status === 304) return { notModified: true };
  if (!res.ok) throw new Error(`Dropbox answered ${res.status} ${res.statusText}.`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!looksLikeXlsx(bytes)) {
    throw new Error(
      "Dropbox sent a web page instead of the file. The link may have expired or been turned off, or it may point at a folder.",
    );
  }
  return { notModified: false, bytes, etag: res.headers.get("etag") };
}

async function recordCheck(shop: string, url: string, actor: Actor, status: string, detail: string) {
  await prisma.priceListSource.upsert({
    where: { shop },
    create: {
      shop,
      url,
      updatedById: actor.id,
      updatedByName: actor.name,
      lastCheckedAt: new Date(),
      lastCheckStatus: status,
      lastCheckDetail: detail,
    },
    update: { lastCheckedAt: new Date(), lastCheckStatus: status, lastCheckDetail: detail },
  });
}

/**
 * Downloads the file and imports it if its contents differ from every
 * version already stored. Never throws: failures come back as `failed` and
 * are written to the activity log.
 */
export async function checkPriceList(shop: string, trigger: ScanTrigger, actor: Actor): Promise<CheckResult> {
  const url = await priceListUrl(shop);
  try {
    // Only trust the etag of the newest import that came from this same link.
    const latest = await prisma.priceListImport.findFirst({
      where: { shop },
      orderBy: { importedAt: "desc" },
      select: { id: true, etag: true, sourceUrl: true },
    });
    const knownEtag = latest && latest.sourceUrl === url ? latest.etag : null;
    const got = await download(url, knownEtag);
    if (got.notModified) {
      await recordCheck(shop, url, actor, "unchanged", `Dropbox says the file hasn't changed since version ${latest!.id}.`);
      return { status: "unchanged", importId: latest!.id };
    }
    const { bytes, etag } = got;
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const existing = await prisma.priceListImport.findUnique({ where: { shop_sha256: { shop, sha256 } } });
    if (existing) {
      await recordCheck(shop, url, actor, "unchanged", `Same file as version ${existing.id}.`);
      return { status: "unchanged", importId: existing.id };
    }

    const parsed = await parsePriceList(bytes);
    const fileName = fileNameFromUrl(url);

    const created = await prisma.$transaction(
      async (tx) => {
        const imp = await tx.priceListImport.create({
          data: {
            shop,
            sourceUrl: url,
            fileName,
            etag,
            sha256,
            byteSize: bytes.length,
            sheetName: parsed.sheetName,
            columns: parsed.columns,
            rowCount: parsed.rows.length,
            trigger,
            triggeredById: actor.id,
            triggeredByName: actor.name,
          },
        });
        for (let i = 0; i < parsed.rows.length; i += INSERT_CHUNK) {
          await tx.priceListItem.createMany({
            data: parsed.rows.slice(i, i + INSERT_CHUNK).map((r) => ({
              importId: imp.id,
              itemNumber: r.itemNumber,
              upc: r.upc,
              productName: r.productName,
              collection: r.collection,
              category: r.category,
              wholesaleCents: r.wholesaleCents,
              dropShipFeeCents: r.dropShipFeeCents,
              totalPriceCents: r.totalPriceCents,
              mapCents: r.mapCents,
              shipMethod: r.shipMethod,
              shippingClass: r.shippingClass,
              boxSize: r.boxSize,
              shippingWeight: r.shippingWeight,
              data: r.data,
            })),
          });
        }
        await appendAudit(
          {
            shop,
            actor,
            eventType: EVENT_TYPES.priceListImported,
            after: { importId: imp.id, fileName, rows: parsed.rows.length, sha256, etag },
            inputs: { url, trigger },
          },
          tx,
        );
        return imp;
      },
      { timeout: 120_000, maxWait: 30_000 },
    );

    await pruneOldVersions(shop);
    await recordCheck(shop, url, actor, "imported", `Imported ${parsed.rows.length} items as version ${created.id}.`);
    return { status: "imported", importId: created.id, rowCount: parsed.rows.length };
  } catch (e) {
    // Two checks at once can both try to import the same new file.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const imp = await prisma.priceListImport.findFirst({ where: { shop }, orderBy: { importedAt: "desc" } });
      if (imp) return { status: "unchanged", importId: imp.id };
    }
    const error = e instanceof Error ? e.message : String(e);
    await recordCheck(shop, url, actor, "failed", error).catch(() => {});
    await appendAudit({
      shop,
      actor,
      eventType: EVENT_TYPES.priceListCheckFailed,
      inputs: { url, trigger },
      reason: error,
    }).catch(() => {});
    return { status: "failed", error };
  }
}

async function pruneOldVersions(shop: string) {
  const keep = await prisma.priceListImport.findMany({
    where: { shop },
    orderBy: { importedAt: "desc" },
    take: KEEP_VERSIONS,
    select: { id: true },
  });
  if (keep.length < KEEP_VERSIONS) return;
  await prisma.priceListImport.deleteMany({
    where: { shop, id: { notIn: keep.map((k) => k.id) } },
  });
}
