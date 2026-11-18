import { describe, expect, it } from "vitest";
import { checkRates, computeDrift, needsAttention, type RateDefinition, type VariantRow } from "./drift";

const row = (over: Partial<VariantRow>): VariantRow => ({
  variantId: "gid://shopify/ProductVariant/1",
  variantTitle: "Default Title",
  productId: "gid://shopify/Product/1",
  productTitle: "Thing",
  status: "ACTIVE",
  shippingMethod: null,
  requiresShipping: true,
  profileId: "gid://shopify/DeliveryProfile/1",
  profileName: "General profile",
  ...over,
});

const rate = (min: number | null, max: number | null, price = 100): RateDefinition => ({
  name: "US Oversized Freight",
  active: true,
  price,
  conditions: [
    ...(min != null ? [{ field: "TOTAL_PRICE", operator: "GREATER_THAN_OR_EQUAL_TO", amount: min }] : []),
    ...(max != null ? [{ field: "TOTAL_PRICE", operator: "LESS_THAN_OR_EQUAL_TO", amount: max }] : []),
  ],
});
const OK_RATES = [rate(0, 1000, 200), rate(1000.01, null, 100)];

describe("computeDrift", () => {
  it("finds tagged products outside Freight and untagged ones inside", () => {
    const d = computeDrift(
      [
        row({ variantId: "v1", productTitle: "Sofa", shippingMethod: "Motor Freight" }),
        row({ variantId: "v2", productTitle: "Rug", shippingMethod: "Oversize", profileName: "Freight" }),
        row({ variantId: "v3", productTitle: "Vase", shippingMethod: "Small Parcel", profileName: "Freight" }),
        row({ variantId: "v4", productTitle: "Lamp", shippingMethod: null, profileName: "Freight" }),
        row({ variantId: "v5", productTitle: "Pull", shippingMethod: "Small Parcel" }),
      ],
      OK_RATES,
    );
    expect(d.toAdd.map((i) => i.variantId)).toEqual(["v1"]);
    expect(d.toRemove.map((i) => i.title)).toEqual(["Lamp", "Vase"]);
    expect(d.counts).toEqual({
      variants: 5,
      inFreight: 3,
      byMethod: { "Motor Freight": 1, Oversize: 1, "Small Parcel": 2, "Not set": 1 },
    });
    expect(needsAttention(d)).toBe(true);
  });

  it("reports active non-physical and Collective products instead of moving them", () => {
    const d = computeDrift(
      [
        row({ variantId: "v1", productTitle: "Bench", shippingMethod: "Motor Freight", requiresShipping: false, profileName: null }),
        row({ variantId: "v2", productTitle: "Draft bench", status: "DRAFT", shippingMethod: "Motor Freight", requiresShipping: false }),
        row({ variantId: "v3", productTitle: "Lamp", shippingMethod: "Oversize", profileName: "Shopify Collective" }),
      ],
      OK_RATES,
    );
    expect(d.toAdd).toEqual([]);
    expect(d.notPhysical.map((i) => i.variantId)).toEqual(["v1"]);
    expect(d.protectedProfile.map((i) => i.variantId)).toEqual(["v3"]);
  });

  it("uses the variant title when there is more than one variant", () => {
    const d = computeDrift([row({ variantTitle: "6' x 9'", productTitle: "Silada", shippingMethod: "Oversize" })], OK_RATES);
    expect(d.toAdd[0].title).toBe("Silada – 6' x 9'");
  });

  it("has the same fingerprint for the same state in any order, and a new one when a tag changes", () => {
    const a = row({ variantId: "v1", shippingMethod: "Oversize", profileName: "Freight" });
    const b = row({ variantId: "v2", shippingMethod: "Small Parcel" });
    const f1 = computeDrift([a, b], OK_RATES).fingerprint;
    expect(computeDrift([b, a], OK_RATES).fingerprint).toBe(f1);
    expect(computeDrift([a, { ...b, shippingMethod: "Motor Freight" }], OK_RATES).fingerprint).not.toBe(f1);
    expect(computeDrift([a, { ...b, profileName: "Freight" }], OK_RATES).fingerprint).not.toBe(f1);
  });

  it("is clean when everything matches", () => {
    const d = computeDrift([row({ shippingMethod: "Oversize", profileName: "Freight" })], OK_RATES);
    expect(needsAttention(d)).toBe(false);
  });

  it("warns when there is no Freight profile", () => {
    expect(computeDrift([], null).rateWarnings[0]).toMatch(/no shipping profile named "Freight"/);
  });
});

describe("checkRates", () => {
  it("is happy with rates that cover every order total", () => {
    expect(checkRates(OK_RATES)).toEqual([]);
  });
  it("flags the missing top tier (HTGT's setup on 2026-11-17)", () => {
    expect(checkRates([rate(0, 1000, 200), rate(1000.01, 2000, 100)])).toEqual([
      "Freight has no rate for orders over $2,000.00, so those carts can't check out.",
    ]);
  });
  it("flags gaps between tiers and below the first", () => {
    expect(checkRates([rate(50, 500), rate(800, null)])).toEqual([
      "Freight has no rate for orders under $50.00.",
      "Freight has no rate for orders between $500.00 and $800.00.",
    ]);
  });
  it("treats a rate with no conditions as covering everything", () => {
    expect(checkRates([rate(null, null)])).toEqual([]);
  });
  it("flags a profile with no active rates", () => {
    expect(checkRates([{ ...rate(0, null), active: false }])[0]).toMatch(/no active rates/);
  });
});
