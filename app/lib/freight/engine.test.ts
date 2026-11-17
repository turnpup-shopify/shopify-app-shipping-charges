import { describe, expect, it } from "vitest";
import {
  describeFix,
  evaluateVariant,
  formatMoney,
  formatPct,
  measureBox,
  pickTier,
  roundUpToNine,
  type EvaluationComplete,
  type VariantInputs,
} from "./engine";
import { DEFAULT_SETTINGS, validateSettings, type FreightSettings } from "./settings";
import { parseDimension, parseMoney, weightToLb } from "./parse";

const S = DEFAULT_SETTINGS;

const base: VariantInputs = {
  price: 100,
  compareAtPrice: null,
  unitCost: 40,
  weightLb: 10,
  boxLength: 20,
  boxWidth: 10,
  boxHeight: 10,
  boxCount: null,
  overrideCost: null,
  map: null,
};

function complete(input: Partial<VariantInputs>, s: FreightSettings = S): EvaluationComplete {
  const r = evaluateVariant({ ...base, ...input }, s);
  if (r.status !== "complete") throw new Error(`expected complete, got missing ${r.missing}`);
  return r;
}

const line = (r: EvaluationComplete, key: string) => r.lines.find((l) => l.key === key)!;

// ---------------------------------------------------------------------------
// Required test case: the mirror
// ---------------------------------------------------------------------------
describe("required case: mirror", () => {
  // 110 in long box → longest side over 108 → Freight (LTL) at $250.
  const r = complete({
    price: 328,
    unitCost: 137,
    weightLb: 60,
    boxLength: 110,
    boxWidth: 40,
    boxHeight: 4,
    map: null,
  });

  it("is in the LTL tier at $250", () => {
    expect(r.freight.tierKey).toBe("ltl");
    expect(r.freight.totalCents).toBe(25000);
  });
  it("landed cost is $387.00", () => {
    expect(r.landedCostCents).toBe(38700);
    expect(formatMoney(r.landedCostCents)).toBe("$387.00");
  });
  it("margin after freight is −$59.00, −18.0%", () => {
    expect(r.marginCents).toBe(-5900);
    expect(formatMoney(r.marginCents)).toBe("−$59.00");
    expect(formatPct(r.marginPct)).toBe("−18.0%");
  });
  it("at 10% off is −$91.80, −31.1%", () => {
    expect(r.marginAtDiscountCents).toBe(-9180);
    expect(formatPct(r.marginAtDiscountPct)).toBe("−31.1%");
  });
  it("suggested price is $519 (516 rounded up to a 9 ending)", () => {
    expect(r.suggestedPriceCents).toBe(51900);
  });
  it("price increase is +58%", () => {
    expect(formatPct(r.priceIncreasePct, 0, true)).toBe("+58%");
  });
  it("suggested surcharge is $141.00", () => {
    expect(r.suggestedSurchargeCents).toBe(14100);
  });
  it("suggested fix is Freight surcharge, plus Exclude from discounts", () => {
    expect(r.suggestedFix).toBe("surcharge");
    expect(r.excludeFromDiscounts).toBe(true);
    expect(r.suggestedValueCents).toBe(14100);
    expect(describeFix(r.suggestedFix, r.excludeFromDiscounts)).toBe(
      "Freight surcharge, plus Exclude from discounts",
    );
  });
  it("is critical", () => {
    expect(r.severity).toBe("critical");
  });
  it("explains every number on the receipt", () => {
    for (const l of r.lines) expect(l.how.length).toBeGreaterThan(10);
    expect(line(r, "landed_cost").how).toContain("$137.00");
    expect(line(r, "landed_cost").how).toContain("$250.00");
    expect(line(r, "suggested_price").how).toContain("$516.00");
    expect(line(r, "freight").how).toMatch(/longest side 110 in is over 108/);
  });
});

// ---------------------------------------------------------------------------
// Individual formulas
// ---------------------------------------------------------------------------
describe("size, dimensional weight, billable weight", () => {
  it("size = longest + 2 × width + 2 × height", () => {
    expect(measureBox(20, 10, 5, 1, 139).size).toBe(20 + 20 + 10);
    // Order of inputs does not matter: the longest side is the length.
    expect(measureBox(5, 20, 10, 1, 139).size).toBe(50);
  });
  it("dimensional weight = L × W × H ÷ 139", () => {
    expect(measureBox(20, 10, 10, 1, 139).dimWeight).toBeCloseTo(2000 / 139, 10);
  });
  it("billable weight is the larger of actual and dimensional", () => {
    expect(measureBox(20, 10, 10, 30, 139).billableWeight).toBe(30);
    expect(measureBox(40, 40, 40, 30, 139).billableWeight).toBeCloseTo(64000 / 139, 10);
  });
  it("respects a custom divisor", () => {
    expect(measureBox(10, 10, 10, null, 166).dimWeight).toBeCloseTo(1000 / 166, 10);
  });
});

describe("tier boundaries", () => {
  const m = (size: number, billable: number, longest = 50) => ({
    size,
    billableWeight: billable,
    longestSide: longest,
    dimWeight: 0,
    actualWeightPerBox: billable,
  });
  const tier = (size: number, billable: number, longest?: number) =>
    pickTier(m(size, billable, longest), S.tiers).key;

  it("size exactly 130 is Parcel", () => expect(tier(130, 10)).toBe("parcel"));
  it("size just over 130 is Large parcel", () => expect(tier(130.01, 10)).toBe("large_parcel"));
  it("size exactly 165 is Large parcel", () => expect(tier(165, 10)).toBe("large_parcel"));
  it("size just over 165 is LTL", () => expect(tier(165.01, 10)).toBe("ltl"));
  it("billable exactly 50 is Parcel", () => expect(tier(100, 50)).toBe("parcel"));
  it("billable just over 50 is Large parcel", () => expect(tier(100, 50.01)).toBe("large_parcel"));
  it("billable exactly 150 is Large parcel", () => expect(tier(100, 150)).toBe("large_parcel"));
  it("billable just over 150 is LTL", () => expect(tier(100, 150.01)).toBe("ltl"));
  it("longest side exactly 108 is not forced to LTL", () => expect(tier(120, 10, 108)).toBe("parcel"));
  it("longest side over 108 is LTL even when small and light", () =>
    expect(tier(120, 10, 108.5)).toBe("ltl"));
  it("small size but heavy is Large parcel", () => expect(tier(60, 80)).toBe("large_parcel"));

  it("end to end: a box with size exactly 130 ships Parcel at $25", () => {
    // 90 + 2×10 + 2×10 = 130. A huge divisor keeps dimensional weight out of the way.
    const r = complete({ boxLength: 90, boxWidth: 10, boxHeight: 10, weightLb: 5 }, { ...S, dimDivisor: 10000 });
    expect(r.freight.size).toBe(130);
    expect(r.freight.tierKey).toBe("parcel");
    expect(r.freight.totalCents).toBe(2500);
  });
});

describe("landed cost and margins", () => {
  it("landed cost = unit cost + freight", () => {
    const r = complete({ unitCost: 40 }); // 20×10×10, 10 lb → Parcel $25
    expect(r.freight.tierKey).toBe("parcel");
    expect(r.landedCostCents).toBe(6500);
  });
  it("margin = (price − landed) ÷ price", () => {
    const r = complete({ price: 100, unitCost: 40 });
    expect(r.marginCents).toBe(3500);
    expect(r.marginPct).toBeCloseTo(0.35, 10);
    expect(r.severity).toBe("ok");
    expect(r.suggestedFix).toBe("none");
  });
  it("margin at max discount uses the discounted price as the base", () => {
    const r = complete({ price: 100, unitCost: 40 });
    expect(r.discountPriceCents).toBe(9000);
    expect(r.marginAtDiscountCents).toBe(2500);
    expect(r.marginAtDiscountPct).toBeCloseTo(25 / 90, 10);
  });
  it("uses the configured max discount", () => {
    const r = complete({ price: 100, unitCost: 40 }, { ...S, maxDiscount: 0.4 });
    expect(r.discountPriceCents).toBe(6000);
    expect(r.marginAtDiscountCents).toBe(-500);
    expect(r.excludeFromDiscounts).toBe(true);
  });
});

describe("severity", () => {
  it("flagged when under 20% but not under 0%", () => {
    const r = complete({ price: 100, unitCost: 60 }); // landed 85 → 15%
    expect(r.severity).toBe("flagged");
  });
  it("exactly 20% is not flagged", () => {
    const r = complete({ price: 100, unitCost: 55 }); // landed 80 → 20%
    expect(r.marginPct).toBeCloseTo(0.2, 10);
    expect(r.severity).toBe("ok");
  });
  it("critical when under 0%", () => {
    const r = complete({ price: 100, unitCost: 80 }); // landed 105
    expect(r.severity).toBe("critical");
  });
  it("exactly 0% is flagged, not critical", () => {
    const r = complete({ price: 100, unitCost: 75 }); // landed 100
    expect(r.severity).toBe("flagged");
  });
});

describe("suggested price", () => {
  it("rounds up to a price ending in 9", () => {
    expect(roundUpToNine(51600)).toBe(51900);
    expect(roundUpToNine(51900)).toBe(51900);
    expect(roundUpToNine(51901)).toBe(52900);
    expect(roundUpToNine(52000)).toBe(52900);
    expect(roundUpToNine(51000)).toBe(51900);
    expect(roundUpToNine(800)).toBe(900);
    expect(roundUpToNine(1)).toBe(900);
  });
  it("= landed ÷ (1 − target margin), rounded", () => {
    const r = complete({ price: 100, unitCost: 60 }); // landed 85 → 113.33 → 119
    expect(r.suggestedPriceCents).toBe(11900);
    expect(r.priceIncreasePct).toBeCloseTo(0.19, 10);
    expect(r.suggestedFix).toBe("reprice");
    expect(r.suggestedValueCents).toBe(11900);
  });
  it("MAP above the suggested price wins", () => {
    const r = complete({ price: 100, unitCost: 60, map: 130 });
    expect(r.suggestedPriceCents).toBe(13900); // 130 → rounded to 139
    expect(line(r, "suggested_price").how).toContain("MAP is $130.00");
  });
  it("MAP below the suggested price is ignored", () => {
    const r = complete({ price: 100, unitCost: 60, map: 90 });
    expect(r.suggestedPriceCents).toBe(11900);
  });
  it("MAP that pushes the increase over the limit changes the fix", () => {
    const r = complete({ price: 100, unitCost: 60, map: 150 }); // 159 → +59%
    expect(r.suggestedFix).toBe("surcharge");
  });
});

describe("suggested surcharge", () => {
  it("= landed − price × (1 − target)", () => {
    const r = complete({ price: 100, unitCost: 60 }); // 85 − 75 = 10
    expect(r.suggestedSurchargeCents).toBe(1000);
  });
  it("is never negative", () => {
    const r = complete({ price: 100, unitCost: 10 });
    expect(r.suggestedSurchargeCents).toBe(0);
  });
});

describe("suggested fix, first match wins", () => {
  it("increase of exactly 35% is Reprice", () => {
    // Need suggested price = 135 × price. Price 100 → suggested 135 isn't a 9 ending,
    // so set price so that the 9-ending lands exactly: price 140 → 189 is +35%.
    // landed must give target ≤ 189: landed 141.75 → 189.
    const r = complete({ price: 140, unitCost: 116.75 }); // landed 141.75 → 189.00
    expect(r.suggestedPriceCents).toBe(18900);
    expect(r.priceIncreasePct).toBeCloseTo(0.35, 10);
    expect(r.suggestedFix).toBe("reprice");
  });
  it("surcharge of exactly $150 is Freight surcharge", () => {
    // landed − 0.75 × price = 150 with a big increase. price 100: landed 225.
    const r = complete({ price: 100, unitCost: 200 });
    expect(r.suggestedSurchargeCents).toBe(15000);
    expect(r.suggestedFix).toBe("surcharge");
  });
  it("otherwise Showroom only or Delist", () => {
    const r = complete({ price: 100, unitCost: 300 });
    expect(r.suggestedFix).toBe("showroom_or_delist");
    expect(r.suggestedValueCents).toBeNull();
  });
  it("adds Exclude from discounts when margin at max discount is below 0", () => {
    const r = complete({ price: 100, unitCost: 66 }); // landed 91, at 10% off 90 − 91 < 0
    expect(r.excludeFromDiscounts).toBe(true);
    expect(describeFix(r.suggestedFix, true)).toBe("Reprice, plus Exclude from discounts");
  });
  it("an OK item can still need Exclude from discounts", () => {
    const r = complete({ price: 100, unitCost: 55 }, { ...S, maxDiscount: 0.3 });
    expect(r.severity).toBe("ok");
    expect(r.suggestedFix).toBe("none");
    expect(r.excludeFromDiscounts).toBe(true);
    expect(describeFix("none", true)).toBe("Exclude from discounts");
  });
});

// ---------------------------------------------------------------------------
// Data problems and special cases
// ---------------------------------------------------------------------------
describe("missing data", () => {
  it("missing unit cost is incomplete but still works out freight", () => {
    const r = evaluateVariant({ ...base, unitCost: null }, S);
    expect(r.status).toBe("incomplete");
    if (r.status !== "incomplete") return;
    expect(r.missing).toEqual(["unit_cost"]);
    expect(r.freight?.tierKey).toBe("parcel");
  });
  it("missing any dimension is incomplete", () => {
    const r = evaluateVariant({ ...base, boxHeight: null }, S);
    expect(r.status).toBe("incomplete");
    if (r.status !== "incomplete") return;
    expect(r.missing).toEqual(["dimensions"]);
    expect(r.freight).toBeNull();
  });
  it("zero dimensions count as missing", () => {
    const r = evaluateVariant({ ...base, boxWidth: 0 }, S);
    expect(r.status === "incomplete" && r.missing).toEqual(["dimensions"]);
  });
  it("missing price is incomplete", () => {
    const r = evaluateVariant({ ...base, price: 0 }, S);
    expect(r.status === "incomplete" && r.missing).toEqual(["price"]);
  });
  it("lists everything that is missing", () => {
    const r = evaluateVariant({ ...base, price: null, unitCost: null, boxLength: null }, S);
    expect(r.status === "incomplete" && r.missing).toEqual(["price", "unit_cost", "dimensions"]);
  });
  it("missing weight falls back to dimensional weight with a warning", () => {
    const r = complete({ weightLb: null, boxLength: 40, boxWidth: 30, boxHeight: 20 });
    expect(r.freight.billableWeight).toBeCloseTo(24000 / 139, 10);
    expect(r.freight.tierKey).toBe("ltl"); // 172.7 lb billable
    expect(r.warnings.join(" ")).toMatch(/Weight is missing/);
  });
});

describe("manual override", () => {
  it("always wins over the tier and shows as Manual", () => {
    const r = complete({ overrideCost: 75, boxLength: 120, boxWidth: 40, boxHeight: 40 });
    expect(r.freight.source).toBe("manual");
    expect(r.freight.tierName).toBe("Manual");
    expect(r.freight.totalCents).toBe(7500);
    expect(line(r, "freight").label).toBe("Freight (Manual)");
  });
  it("works with no dimensions", () => {
    const r = complete({ overrideCost: 75, boxLength: null, boxWidth: null, boxHeight: null });
    expect(r.freight.totalCents).toBe(7500);
  });
  it("an override of $0 is respected", () => {
    const r = complete({ overrideCost: 0 });
    expect(r.freight.totalCents).toBe(0);
  });
  it("is the total for the unit by default, even with several boxes", () => {
    const r = complete({ overrideCost: 300, boxCount: 3 });
    expect(r.freight.totalCents).toBe(30000);
  });
  it("is multiplied by box count when the per-box setting is on", () => {
    const r = complete({ overrideCost: 100, boxCount: 3 }, { ...S, overrideIsPerBox: true });
    expect(r.freight.totalCents).toBe(30000);
  });
});

describe("multi box", () => {
  it("freight is multiplied by box count", () => {
    const r = complete({ boxCount: 3 }); // each box Parcel $25
    expect(r.freight.totalCents).toBe(7500);
    expect(r.landedCostCents).toBe(4000 + 7500);
  });
  it("splits total weight across boxes for the tier check", () => {
    // 120 lb over 3 boxes = 40 lb each → Parcel. In one box it would be Large.
    const three = complete({ weightLb: 120, boxCount: 3 });
    expect(three.freight.actualWeightPerBox).toBe(40);
    expect(three.freight.tierKey).toBe("parcel");
    const one = complete({ weightLb: 120, boxCount: 1 });
    expect(one.freight.tierKey).toBe("large_parcel");
  });
  it("bad box counts fall back to 1 with a warning", () => {
    const r = complete({ boxCount: 0 });
    expect(r.freight.boxCount).toBe(1);
    expect(r.warnings.length).toBe(1);
    expect(complete({ boxCount: 2.5 }).freight.boxCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Parsing Shopify values
// ---------------------------------------------------------------------------
describe("parsing", () => {
  it("converts weight units to pounds", () => {
    expect(weightToLb({ value: 16, unit: "OUNCES" })).toBe(1);
    expect(weightToLb({ value: 1, unit: "KILOGRAMS" })).toBeCloseTo(2.2046, 4);
    expect(weightToLb({ value: 1000, unit: "GRAMS" })).toBeCloseTo(2.2046, 4);
    expect(weightToLb({ value: 5, unit: "POUNDS" })).toBe(5);
    expect(weightToLb(null)).toBeNull();
  });
  it("reads plain and dimension-type metafields", () => {
    expect(parseDimension("42.5")).toBe(42.5);
    expect(parseDimension('{"value":2.54,"unit":"cm"}')).toBeCloseTo(1, 10);
    expect(parseDimension('{"value":2,"unit":"ft"}')).toBe(24);
    expect(parseDimension("")).toBeNull();
    expect(parseDimension("abc")).toBeNull();
  });
  it("reads plain and money-type metafields", () => {
    expect(parseMoney("250")).toBe(250);
    expect(parseMoney('{"amount":"199.99","currency_code":"USD"}')).toBe(199.99);
    expect(parseMoney(null)).toBeNull();
  });
});

describe("settings validation", () => {
  it("accepts the defaults", () => expect(validateSettings(S)).toEqual([]));
  it("rejects a critical threshold above the flag threshold", () => {
    expect(validateSettings({ ...S, criticalThreshold: 0.3 })).not.toEqual([]);
  });
  it("rejects a 100% target margin", () => {
    expect(validateSettings({ ...S, targetMargin: 1 })).not.toEqual([]);
  });
});
