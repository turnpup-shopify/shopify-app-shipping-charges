import { describe, expect, it } from "vitest";
import { applyQuery, DEFAULT_QUERY, queryFromParams, queryToParams } from "./flag-table";
import type { FlagRow } from "./flags.server";

const row = (o: Partial<FlagRow>): FlagRow => ({
  id: 1,
  productId: "p",
  variantId: "v",
  title: "Mirror",
  imageUrl: null,
  priceCents: 32800,
  unitCostCents: 13700,
  freightCents: 25000,
  tier: "Freight (LTL)",
  landedCostCents: 38700,
  marginPct: -0.18,
  marginCents: -5900,
  marginAtDiscountPct: -0.311,
  severity: "CRITICAL",
  suggestedFix: "surcharge",
  excludeFromDiscounts: true,
  suggestedValueCents: 14100,
  unitsSold30d: 3,
  ...o,
});

const rows = [
  row({ id: 1 }),
  row({ id: 2, title: "Bench", priceCents: 50000, marginPct: 0.1, severity: "FLAGGED", tier: "Parcel", suggestedFix: "reprice", excludeFromDiscounts: false }),
  row({ id: 3, title: "Armoire", priceCents: 90000, marginPct: -0.5, tier: "Freight (LTL)", suggestedFix: "showroom_or_delist" }),
];

describe("flag queue sort and filter", () => {
  it("sorts by margin ascending by default", () => {
    expect(applyQuery(rows, DEFAULT_QUERY).map((r) => r.id)).toEqual([3, 1, 2]);
  });
  it("sorts by any column, both directions", () => {
    expect(applyQuery(rows, { ...DEFAULT_QUERY, sort: "title", dir: "asc" }).map((r) => r.title)).toEqual([
      "Armoire",
      "Bench",
      "Mirror",
    ]);
    expect(applyQuery(rows, { ...DEFAULT_QUERY, sort: "priceCents", dir: "desc" }).map((r) => r.id)).toEqual([3, 2, 1]);
  });
  it("filters by text, severity, tier, fix and discount exclusion", () => {
    expect(applyQuery(rows, { ...DEFAULT_QUERY, q: "mirr" }).map((r) => r.id)).toEqual([1]);
    expect(applyQuery(rows, { ...DEFAULT_QUERY, severity: "FLAGGED" }).map((r) => r.id)).toEqual([2]);
    expect(applyQuery(rows, { ...DEFAULT_QUERY, tier: "Parcel" }).map((r) => r.id)).toEqual([2]);
    expect(applyQuery(rows, { ...DEFAULT_QUERY, fix: "showroom_or_delist" }).map((r) => r.id)).toEqual([3]);
    expect(applyQuery(rows, { ...DEFAULT_QUERY, excludeOnly: true }).map((r) => r.id)).toEqual([3, 1]);
  });
  it("filters by dollar and percent ranges", () => {
    expect(applyQuery(rows, { ...DEFAULT_QUERY, priceMin: "400", priceMax: "600" }).map((r) => r.id)).toEqual([2]);
    expect(applyQuery(rows, { ...DEFAULT_QUERY, marginMax: "0" }).map((r) => r.id)).toEqual([3, 1]);
    expect(applyQuery(rows, { ...DEFAULT_QUERY, marginMin: "-20" }).map((r) => r.id)).toEqual([1, 2]);
  });
  it("round-trips through URL params", () => {
    const q = { ...DEFAULT_QUERY, sort: "tier" as const, dir: "desc" as const, excludeOnly: true, priceMin: "10" };
    expect(queryFromParams(queryToParams(q))).toEqual(q);
  });
});
