import { describe, expect, it } from "vitest";
import { parseVariantLine } from "./variant-line";

describe("parseVariantLine", () => {
  it("maps a full bulk JSONL line to engine inputs", () => {
    const p = parseVariantLine({
      id: "gid://shopify/ProductVariant/1",
      title: "Default Title",
      sku: "MIR-1",
      price: "328.00",
      compareAtPrice: null,
      product: {
        id: "gid://shopify/Product/9",
        title: "Arched Mirror",
        status: "ACTIVE",
        featuredMedia: { preview: { image: { url: "https://cdn/x.jpg" } } },
      },
      inventoryItem: {
        requiresShipping: true,
        unitCost: { amount: "137.0" },
        measurement: { weight: { value: 960, unit: "OUNCES" } },
      },
      boxLength: { value: "110" },
      boxWidth: { value: '{"value":40,"unit":"in"}' },
      boxHeight: { value: "4" },
      boxCount: null,
      overrideCost: null,
      map: { value: '{"amount":"299.00","currency_code":"USD"}' },
    })!;
    expect(p.variantTitle).toBeNull();
    expect(p.imageUrl).toBe("https://cdn/x.jpg");
    expect(p.inputs).toEqual({
      price: 328,
      compareAtPrice: null,
      unitCost: 137,
      weightLb: 60,
      boxLength: 110,
      boxWidth: 40,
      boxHeight: 4,
      boxCount: null,
      overrideCost: null,
      map: 299,
    });
    expect(p.rawMetafields["freight.box_length"]).toBe("110");
  });

  it("handles missing cost, weight and metafields", () => {
    const p = parseVariantLine({
      id: "gid://shopify/ProductVariant/2",
      title: "Oak",
      price: "10.00",
      product: { id: "gid://shopify/Product/3", title: "Stool" },
      inventoryItem: { unitCost: null, measurement: { weight: null } },
    })!;
    expect(p.variantTitle).toBe("Oak");
    expect(p.inputs.unitCost).toBeNull();
    expect(p.inputs.weightLb).toBeNull();
    expect(p.inputs.boxLength).toBeNull();
    expect(p.requiresShipping).toBe(true);
  });

  it("skips lines without a product", () => {
    expect(parseVariantLine({ id: "x" })).toBeNull();
  });
});
