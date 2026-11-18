import { describe, expect, it } from "vitest";
import { adminAppUrl, buildDailyEmail } from "./daily-report";
import { computeDrift, type VariantRow } from "./shipping/drift";

const appUrl = (p: string) => `https://admin.example/app${p}`;
const quiet = { changed: false, drift: computeDrift([], [{ name: "x", active: true, price: 0, conditions: [] }]) };
const v = (id: string, method: string | null, profile: string): VariantRow => ({
  variantId: id, variantTitle: "Default Title", productId: `p${id}`, productTitle: `Product ${id}`,
  status: "ACTIVE", shippingMethod: method, requiresShipping: true, profileId: null, profileName: profile,
});

describe("buildDailyEmail", () => {
  it("sends nothing on a quiet day", () => {
    expect(buildDailyEmail({ shop: "s.myshopify.com", appUrl, priceList: { status: "unchanged", importId: 1 }, shipping: quiet })).toBeNull();
  });

  it("sends nothing when the shipping state is unchanged, even if it still needs attention", () => {
    const drift = computeDrift([v("1", "Oversize", "General profile")], null);
    expect(buildDailyEmail({ shop: "s", appUrl, priceList: { status: "unchanged", importId: 1 }, shipping: { changed: false, drift } })).toBeNull();
  });

  it("reports a new price list", () => {
    const e = buildDailyEmail({ shop: "s", appUrl, priceList: { status: "imported", importId: 7, rowCount: 2758 }, shipping: quiet })!;
    expect(e.subject).toBe("Freight Margin Guard: New Uttermost price list");
    expect(e.text).toContain("Imported 2,758 items as version 7.");
    expect(e.text).toContain("https://admin.example/app/app/price-list");
  });

  it("lists shipping drift with a link to fix it, and escapes HTML", () => {
    const drift = computeDrift(
      [v("1", "Motor Freight", "General profile"), v("2", null, "Freight"), { ...v("3", "Oversize", "General profile"), productTitle: "<Sofa> & co" }],
      [{ name: "r", active: true, price: 100, conditions: [{ field: "TOTAL_PRICE", operator: "LESS_THAN_OR_EQUAL_TO", amount: 2000 }] }],
    );
    const e = buildDailyEmail({ shop: "s", appUrl, priceList: { status: "failed", error: "Dropbox answered 404" }, shipping: { changed: true, drift } })!;
    expect(e.subject).toBe("Freight Margin Guard: 2 things need a look");
    expect(e.text).toContain("Tagged Oversize or Motor Freight but not in the Freight profile: 2");
    expect(e.text).toContain("In the Freight profile but not tagged Oversize or Motor Freight: 1");
    expect(e.text).toContain("Rate problem: Freight has no rate for orders over $2,000.00");
    expect(e.text).toContain("Dropbox answered 404");
    expect(e.html).toContain("&lt;Sofa&gt; &amp; co");
    expect(e.html).not.toContain("<Sofa>");
  });

  it("caps long lists", () => {
    const rows = Array.from({ length: 20 }, (_, i) => v(String(i).padStart(2, "0"), "Oversize", "General profile"));
    const e = buildDailyEmail({ shop: "s", appUrl, priceList: { status: "unchanged", importId: 1 }, shipping: { changed: true, drift: computeDrift(rows, null) } })!;
    expect(e.text).toContain("…and 5 more");
  });
});

describe("adminAppUrl", () => {
  it("links into the embedded app", () => {
    expect(adminAppUrl("htgtfurniture.myshopify.com", "/app/shipping", "freight-margin-guard")).toBe(
      "https://admin.shopify.com/store/htgtfurniture/apps/freight-margin-guard/app/shipping",
    );
  });
});
