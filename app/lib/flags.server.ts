import prisma from "../db.server";
import { latestFinishedScan } from "./data.server";
import type { SuggestedFix } from "./freight/engine";

export interface FlagRow {
  id: number;
  productId: string;
  variantId: string;
  title: string;
  imageUrl: string | null;
  priceCents: number;
  unitCostCents: number;
  freightCents: number;
  tier: string;
  landedCostCents: number;
  marginPct: number;
  marginCents: number;
  marginAtDiscountPct: number;
  severity: "FLAGGED" | "CRITICAL";
  suggestedFix: SuggestedFix;
  excludeFromDiscounts: boolean;
  suggestedValueCents: number | null;
  unitsSold30d: number | null;
}

export async function flagsForLatestScan(shop: string) {
  const scan = await latestFinishedScan(shop);
  if (!scan) return { scan: null, rows: [] as FlagRow[] };
  const flags = await prisma.flag.findMany({
    where: { scanId: scan.id },
    orderBy: { marginPct: "asc" },
  });
  const rows: FlagRow[] = flags.map((f) => ({
    id: f.id,
    productId: f.productId,
    variantId: f.variantId,
    title: f.variantTitle ? `${f.productTitle} – ${f.variantTitle}` : f.productTitle,
    imageUrl: f.imageUrl,
    priceCents: f.priceCents,
    unitCostCents: f.unitCostCents,
    freightCents: f.freightCents,
    tier: f.tier,
    landedCostCents: f.landedCostCents,
    marginPct: Number(f.marginPct),
    marginCents: f.priceCents - f.landedCostCents,
    marginAtDiscountPct: Number(f.marginAtDiscountPct),
    severity: f.severity,
    suggestedFix: f.suggestedFix as SuggestedFix,
    excludeFromDiscounts: f.excludeFromDiscounts,
    suggestedValueCents: f.suggestedValueCents,
    unitsSold30d: f.unitsSold30d,
  }));
  return { scan, rows };
}
