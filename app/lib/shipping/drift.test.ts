import { describe, expect, it } from "vitest";
import {
  belongsInFreight,
  checkRates,
  computeDrift,
  needsAttention,
  type FreightProfile,
  type RateDefinition,
  type VariantRow,
} from "./drift";

const FREIGHT_ID = "gid://shopify/DeliveryProfile/89594986703";
const GENERAL_ID = "gid://shopify/DeliveryProfile/1";

const row = (over: Partial<VariantRow>): VariantRow => ({
  variantId: "gid://shopify/ProductVariant/1",
  variantTitle: "Default Title",
  productId: "gid://shopify/Product/1",
  productTitle: "Thing",
  status: "ACTIVE",
  shippingMethod: null,
  tags: [],
  requiresShipping: true,
  profileId: GENERAL_ID,
  profileName: "General profile",
  ...over,
});
const inFreight = { profileId: FREIGHT_ID, profileName: "US Motor Freight" };

const rate = (min: number | null, max: number | null, price = 100): RateDefinition => ({
  name: "US Motor Freight",
  active: true,
  price,
  conditions: [
    ...(min != null ? [{ field: "TOTAL_PRICE", operator: "GREATER_THAN_OR_EQUAL_TO", amount: min }] : []),
    ...(max != null ? [{ field: "TOTAL_PRICE", operator: "LESS_THAN_OR_EQUAL_TO", amount: max }] : []),
  ],
});
const PROFILE: FreightProfile = {
  id: FREIGHT_ID,
  name: "US Motor Freight",
  rates: [rate(0, 1000, 200), rate(1000.01, 2000, 100), rate(2000.01, null, 0)],
};

describe("belongsInFreight", () => {
  it("is true for Motor Freight or the motorfreight tag, in any case", () => {
    expect(belongsInFreight({ shippingMethod: "Motor Freight", tags: [] })).toBe(true);
    expect(belongsInFreight({ shippingMethod: null, tags: ["MotorFreight"] })).toBe(true);
    expect(belongsInFreight({ shippingMethod: "Small Parcel", tags: [" motorfreight "] })).toBe(true);
  });
  it("is false for Oversize and anything else", () => {
    expect(belongsInFreight({ shippingMethod: "Oversize", tags: ["oversize"] })).toBe(false);
    expect(belongsInFreight({ shippingMethod: "Small Parcel", tags: ["sale"] })).toBe(false);
    expect(belongsInFreight({ shippingMethod: null, tags: [] })).toBe(false);
  });
});

describe("computeDrift", () => {
  it("adds Motor Freight and tagged products, removes Oversize and untagged ones", () => {
    const d = computeDrift(
      [
        row({ variantId: "v1", productTitle: "Sofa", shippingMethod: "Motor Freight" }),
        row({ variantId: "v2", productTitle: "Bed", tags: ["motorfreight"] }),
        row({ variantId: "v3", productTitle: "Rug", shippingMethod: "Oversize", tags: ["oversize"], ...inFreight }),
        row({ variantId: "v4", productTitle: "Lamp", ...inFreight }),
        row({ variantId: "v5", productTitle: "Desk", shippingMethod: "Motor Freight", ...inFreight }),
        row({ variantId: "v6", productTitle: "Pull", shippingMethod: "Small Parcel" }),
      ],
      PROFILE,
    );
    expect(d.toAdd.map((i) => i.title)).toEqual(["Bed", "Sofa"]);
    expect(d.toAdd.find((i) => i.title === "Bed")?.freightTag).toBe(true);
    expect(d.toRemove.map((i) => i.title)).toEqual(["Lamp", "Rug"]);
    expect(d.counts).toEqual({
      variants: 6,
      inFreight: 3,
      belongInFreight: 3,
      profileName: "US Motor Freight",
      byMethod: { "Motor Freight": 2, "Not set": 2, Oversize: 1, "Small Parcel": 1 },
    });
    expect(needsAttention(d)).toBe(true);
  });

  it("matches the profile by ID, so a rename doesn't matter", () => {
    const d = computeDrift(
      [row({ shippingMethod: "Motor Freight", profileId: FREIGHT_ID, profileName: "Old name" })],
      { ...PROFILE, name: "Renamed" },
    );
    expect(d.toAdd).toEqual([]);
    expect(d.counts.inFreight).toBe(1);
  });

  it("reports active non-physical and Collective products instead of moving them", () => {
    const d = computeDrift(
      [
        row({ variantId: "v1", productTitle: "Bench", shippingMethod: "Motor Freight", requiresShipping: false, profileId: null, profileName: null }),
        row({ variantId: "v2", productTitle: "Draft bench", status: "DRAFT", tags: ["motorfreight"], requiresShipping: false }),
        row({ variantId: "v3", productTitle: "Lamp", tags: ["motorfreight"], profileName: "Shopify Collective", profileId: "c" }),
      ],
      PROFILE,
    );
    expect(d.toAdd).toEqual([]);
    expect(d.notPhysical.map((i) => i.variantId)).toEqual(["v1"]);
    expect(d.protectedProfile.map((i) => i.variantId)).toEqual(["v3"]);
  });

  it("uses the variant title when there is more than one variant", () => {
    const d = computeDrift([row({ variantTitle: "6' x 9'", productTitle: "Silada", shippingMethod: "Motor Freight" })], PROFILE);
    expect(d.toAdd[0].title).toBe("Silada – 6' x 9'");
  });

  it("has the same fingerprint for the same state in any order, and a new one when a tag or profile changes", () => {
    const a = row({ variantId: "v1", shippingMethod: "Motor Freight", ...inFreight });
    const b = row({ variantId: "v2", shippingMethod: "Small Parcel" });
    const f1 = computeDrift([a, b], PROFILE).fingerprint;
    expect(computeDrift([b, a], PROFILE).fingerprint).toBe(f1);
    expect(computeDrift([a, { ...b, shippingMethod: "Motor Freight" }], PROFILE).fingerprint).not.toBe(f1);
    expect(computeDrift([a, { ...b, tags: ["motorfreight"] }], PROFILE).fingerprint).not.toBe(f1);
    expect(computeDrift([a, { ...b, ...inFreight }], PROFILE).fingerprint).not.toBe(f1);
  });

  it("is clean when everything matches", () => {
    const d = computeDrift([row({ shippingMethod: "Motor Freight", ...inFreight })], PROFILE);
    expect(needsAttention(d)).toBe(false);
  });

  it("warns when there is no freight profile", () => {
    expect(computeDrift([], null).rateWarnings[0]).toMatch(/no shipping profile named "US Motor Freight"/);
  });
});

describe("checkRates", () => {
  it("is happy with rates that cover every order total (HTGT's setup on 2026-11-18)", () => {
    expect(checkRates(PROFILE.rates)).toEqual([]);
  });
  it("flags the missing top tier, naming the profile", () => {
    expect(checkRates([rate(0, 1000, 200), rate(1000.01, 2000, 100)], "US Motor Freight")).toEqual([
      "US Motor Freight has no rate for orders over $2,000.00, so those carts can't check out.",
    ]);
  });
  it("flags gaps between tiers and below the first", () => {
    expect(checkRates([rate(50, 500), rate(800, null)], "P")).toEqual([
      "P has no rate for orders under $50.00.",
      "P has no rate for orders between $500.00 and $800.00.",
    ]);
  });
  it("treats a rate with no conditions as covering everything", () => {
    expect(checkRates([rate(null, null)])).toEqual([]);
  });
  it("flags a profile with no active rates", () => {
    expect(checkRates([{ ...rate(0, null), active: false }])[0]).toMatch(/no active rates/);
  });
});
