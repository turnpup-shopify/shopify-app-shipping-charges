/**
 * Reads the Uttermost price list workbook. Pure: takes the file bytes, returns
 * rows. Columns are found by header name, so a reordered sheet still works.
 */
import ExcelJS from "exceljs";

export class PriceListParseError extends Error {}

/** Header names in the Uttermost sheet that the app stores in typed columns. */
export const COLUMNS = {
  itemNumber: "Item Number",
  upc: "UPC Number",
  productName: "Product Name",
  collection: "Collection",
  category: "Category",
  wholesale: "Wholesale Price",
  dropShipFee: "Drop Ship Fee",
  totalPrice: "Total Utt. Price",
  map: "MAP",
  shipMethod: "Ship Method",
  shippingClass: "Shipping Class",
  boxSize: "Box Size",
  shippingWeight: "Shipping Weight",
} as const;

export interface PriceListRow {
  itemNumber: string;
  upc: string | null;
  productName: string | null;
  collection: string | null;
  category: string | null;
  wholesaleCents: number | null;
  dropShipFeeCents: number | null;
  totalPriceCents: number | null;
  mapCents: number | null;
  shipMethod: string | null;
  shippingClass: string | null;
  boxSize: string | null;
  shippingWeight: number | null;
  /** Every column from the sheet, keyed by header, as text. */
  data: Record<string, string>;
}

export interface ParsedPriceList {
  sheetName: string;
  columns: string[];
  rows: PriceListRow[];
}

/** "$1,179.00", "179", 179 → cents. Blank or unreadable → null. */
export function moneyToCents(value: string | null | undefined): number | null {
  if (value == null) return null;
  const cleaned = String(value).replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** "18", "18.5 lbs" → number. Blank or unreadable → null. */
export function toNumber(value: string | null | undefined): number | null {
  if (value == null) return null;
  const m = String(value).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** A cell's value as trimmed text, or null when empty. */
export function cellText(value: ExcelJS.CellValue): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("result" in value) return cellText(value.result as ExcelJS.CellValue);
    if ("richText" in value) return cellText(value.richText.map((t) => t.text).join(""));
    if ("text" in value) return cellText(value.text as ExcelJS.CellValue);
    if ("hyperlink" in value) return cellText(String(value.hyperlink));
    if ("error" in value) return null;
    return null;
  }
  const s = String(value).trim();
  return s === "" ? null : s;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Parses the workbook. Uses the first sheet whose header row has an
 * "Item Number" column (the "Items" sheet in Uttermost's file).
 */
export async function parsePriceList(bytes: ArrayBuffer | Uint8Array): Promise<ParsedPriceList> {
  const wb = new ExcelJS.Workbook();
  try {
    // exceljs's types predate Node's generic Buffer; the runtime accepts any Buffer.
    await wb.xlsx.load(Buffer.from(bytes as ArrayBuffer) as unknown as ExcelJS.Buffer);
  } catch (e) {
    throw new PriceListParseError(
      `The file isn't a readable Excel (.xlsx) workbook: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  for (const ws of wb.worksheets) {
    const headerRow = ws.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col] = cellText(cell.value) ?? "";
    });
    const index = new Map<string, number>();
    headers.forEach((h, col) => {
      if (h && !index.has(norm(h))) index.set(norm(h), col);
    });
    const itemCol = index.get(norm(COLUMNS.itemNumber));
    if (!itemCol) continue;

    const columns = headers.filter((h): h is string => Boolean(h));
    const rows: PriceListRow[] = [];
    const seen = new Set<string>();

    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const itemNumber = cellText(row.getCell(itemCol).value);
      if (!itemNumber || seen.has(itemNumber)) return;
      seen.add(itemNumber);

      const data: Record<string, string> = {};
      headers.forEach((h, col) => {
        if (!h) return;
        const v = cellText(row.getCell(col).value);
        if (v != null) data[h] = v;
      });
      const get = (name: string) => {
        const col = index.get(norm(name));
        return col ? cellText(row.getCell(col).value) : null;
      };

      rows.push({
        itemNumber,
        upc: get(COLUMNS.upc),
        productName: get(COLUMNS.productName),
        collection: get(COLUMNS.collection),
        category: get(COLUMNS.category),
        wholesaleCents: moneyToCents(get(COLUMNS.wholesale)),
        dropShipFeeCents: moneyToCents(get(COLUMNS.dropShipFee)),
        totalPriceCents: moneyToCents(get(COLUMNS.totalPrice)),
        mapCents: moneyToCents(get(COLUMNS.map)),
        shipMethod: get(COLUMNS.shipMethod),
        shippingClass: get(COLUMNS.shippingClass),
        boxSize: get(COLUMNS.boxSize),
        shippingWeight: toNumber(get(COLUMNS.shippingWeight)),
        data,
      });
    });

    if (rows.length === 0) throw new PriceListParseError(`Sheet "${ws.name}" has no items.`);
    return { sheetName: ws.name, columns, rows };
  }

  throw new PriceListParseError(`No sheet has an "${COLUMNS.itemNumber}" column in its first row.`);
}
