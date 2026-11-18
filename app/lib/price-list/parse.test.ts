import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { moneyToCents, parsePriceList, PriceListParseError, toNumber } from "./parse";

async function workbook(sheets: Record<string, unknown[][]>): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) wb.addWorksheet(name).addRows(rows);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

const HEADER = ["Item Number", "UPC Number", "Product Name", "Wholesale Price", "Total Utt. Price", "MAP", "Shipping Weight", "Ship Method", "Shipping Class", "Box Size", "Designer"];

describe("moneyToCents", () => {
  it("reads dollar strings and numbers", () => {
    expect(moneyToCents("$179.00")).toBe(17900);
    expect(moneyToCents("$1,179.55")).toBe(117955);
    expect(moneyToCents("42")).toBe(4200);
  });
  it("returns null for blank or junk", () => {
    expect(moneyToCents("")).toBeNull();
    expect(moneyToCents(null)).toBeNull();
    expect(moneyToCents("n/a")).toBeNull();
  });
});

describe("toNumber", () => {
  it("pulls the first number", () => {
    expect(toNumber("18")).toBe(18);
    expect(toNumber("18.5 lbs")).toBe(18.5);
    expect(toNumber("")).toBeNull();
  });
});

describe("parsePriceList", () => {
  it("reads the Items sheet by header name and keeps every column", async () => {
    const bytes = await workbook({
      Items: [
        HEADER,
        ["01101 B", "792977011010", "Sherise Mirror", "$179.00", "$194.00", "$429.60", "18", "EITHER", "Small Parcel", "26.75 L x 36.5 W", "Carolyn Kinder"],
        ["03500", "792977031728", "Nature's Rhythm", "$215.00", "$230.00", "$516.00", "34", "PALLET", "Oversize", null, null],
      ],
      Images: [["Item Number", "Clipped URL"], ["01101 B", "https://example.com/a.jpg"]],
    });
    const out = await parsePriceList(bytes);
    expect(out.sheetName).toBe("Items");
    expect(out.columns).toEqual(HEADER);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]).toMatchObject({
      itemNumber: "01101 B",
      upc: "792977011010",
      wholesaleCents: 17900,
      totalPriceCents: 19400,
      mapCents: 42960,
      shippingWeight: 18,
      shipMethod: "EITHER",
      shippingClass: "Small Parcel",
    });
    expect(out.rows[0].data.Designer).toBe("Carolyn Kinder");
    expect(out.rows[1].boxSize).toBeNull();
    expect(out.rows[1].data).not.toHaveProperty("Box Size");
  });

  it("finds columns in any order and skips blank and repeated item numbers", async () => {
    const bytes = await workbook({
      Items: [
        ["MAP", "item number", "Product Name"],
        ["$10.00", "A1", "First"],
        ["$11.00", null, "No number"],
        ["$12.00", "A1", "Repeat"],
        ["$13.00", "B2", "Second"],
      ],
    });
    const out = await parsePriceList(bytes);
    expect(out.rows.map((r) => [r.itemNumber, r.mapCents, r.productName])).toEqual([
      ["A1", 1000, "First"],
      ["B2", 1300, "Second"],
    ]);
  });

  it("rejects a workbook with no Item Number column", async () => {
    const bytes = await workbook({ Sheet1: [["SKU", "Price"], ["x", 1]] });
    await expect(parsePriceList(bytes)).rejects.toBeInstanceOf(PriceListParseError);
  });

  it("rejects bytes that aren't a workbook", async () => {
    await expect(parsePriceList(new TextEncoder().encode("<html>"))).rejects.toBeInstanceOf(PriceListParseError);
  });
});
