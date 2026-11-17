/**
 * Sorting and filtering for the flag queue. Shared by the screen and the CSV
 * export so the export always matches what's on screen. Pure, unit tested.
 */
import type { FlagRow } from "./flags.server";
import { describeFix, formatMoney, formatPct } from "./freight/engine";

export const COLUMNS = [
  { key: "title", label: "Product", numeric: false },
  { key: "priceCents", label: "Price", numeric: true },
  { key: "unitCostCents", label: "Cost", numeric: true },
  { key: "tier", label: "Tier", numeric: false },
  { key: "landedCostCents", label: "Landed cost", numeric: true },
  { key: "marginPct", label: "Margin", numeric: true },
  { key: "suggestedFix", label: "Suggested fix", numeric: false },
] as const;

export type SortKey = (typeof COLUMNS)[number]["key"];

export interface FlagQuery {
  sort: SortKey;
  dir: "asc" | "desc";
  q: string; // product title contains
  severity: "" | "FLAGGED" | "CRITICAL";
  tier: string;
  fix: string;
  excludeOnly: boolean;
  priceMin: string;
  priceMax: string;
  costMin: string;
  costMax: string;
  landedMin: string;
  landedMax: string;
  marginMin: string; // percent
  marginMax: string; // percent
}

export const DEFAULT_QUERY: FlagQuery = {
  sort: "marginPct",
  dir: "asc",
  q: "",
  severity: "",
  tier: "",
  fix: "",
  excludeOnly: false,
  priceMin: "",
  priceMax: "",
  costMin: "",
  costMax: "",
  landedMin: "",
  landedMax: "",
  marginMin: "",
  marginMax: "",
};

export function queryFromParams(p: URLSearchParams): FlagQuery {
  const q = { ...DEFAULT_QUERY };
  for (const k of Object.keys(DEFAULT_QUERY) as (keyof FlagQuery)[]) {
    const v = p.get(k);
    if (v == null) continue;
    if (k === "excludeOnly") q.excludeOnly = v === "1" || v === "true";
    else (q as Record<string, unknown>)[k] = v;
  }
  if (!COLUMNS.some((c) => c.key === q.sort)) q.sort = DEFAULT_QUERY.sort;
  if (q.dir !== "asc" && q.dir !== "desc") q.dir = "asc";
  return q;
}

export function queryToParams(q: FlagQuery): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    const d = (DEFAULT_QUERY as unknown as Record<string, unknown>)[k];
    if (v === d) continue;
    p.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  }
  return p;
}

const n = (s: string) => (s.trim() === "" ? null : Number(s));
const inRange = (v: number, min: number | null, max: number | null) =>
  (min == null || Number.isNaN(min) || v >= min) && (max == null || Number.isNaN(max) || v <= max);

export function applyQuery(rows: FlagRow[], q: FlagQuery): FlagRow[] {
  const needle = q.q.trim().toLowerCase();
  const dollars = (s: string) => {
    const v = n(s);
    return v == null ? null : Math.round(v * 100);
  };
  const pct = (s: string) => {
    const v = n(s);
    return v == null ? null : v / 100;
  };
  const out = rows.filter(
    (r) =>
      (!needle || r.title.toLowerCase().includes(needle)) &&
      (!q.severity || r.severity === q.severity) &&
      (!q.tier || r.tier === q.tier) &&
      (!q.fix || r.suggestedFix === q.fix) &&
      (!q.excludeOnly || r.excludeFromDiscounts) &&
      inRange(r.priceCents, dollars(q.priceMin), dollars(q.priceMax)) &&
      inRange(r.unitCostCents, dollars(q.costMin), dollars(q.costMax)) &&
      inRange(r.landedCostCents, dollars(q.landedMin), dollars(q.landedMax)) &&
      inRange(r.marginPct, pct(q.marginMin), pct(q.marginMax)),
  );
  const dir = q.dir === "asc" ? 1 : -1;
  return out.sort((a, b) => {
    const av = a[q.sort];
    const bv = b[q.sort];
    const c =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv), "en", { sensitivity: "base" });
    return c !== 0 ? c * dir : a.id - b.id;
  });
}

export const CSV_HEADERS = [
  "Product",
  "Product ID",
  "Variant ID",
  "Severity",
  "Price",
  "Unit cost",
  "Tier",
  "Freight",
  "Landed cost",
  "Margin $",
  "Margin %",
  "Margin at max discount %",
  "Suggested fix",
  "Suggested value",
  "Units sold (30 days)",
];

export function csvRows(rows: FlagRow[]) {
  return rows.map((r) => [
    r.title,
    r.productId,
    r.variantId,
    r.severity === "CRITICAL" ? "Critical" : "Flagged",
    (r.priceCents / 100).toFixed(2),
    (r.unitCostCents / 100).toFixed(2),
    r.tier,
    (r.freightCents / 100).toFixed(2),
    (r.landedCostCents / 100).toFixed(2),
    (r.marginCents / 100).toFixed(2),
    formatPct(r.marginPct),
    formatPct(r.marginAtDiscountPct),
    describeFix(r.suggestedFix, r.excludeFromDiscounts),
    r.suggestedValueCents == null ? "" : formatMoney(r.suggestedValueCents),
    r.unitsSold30d ?? "",
  ]);
}
