import type { SuggestedFix } from "./freight/engine";
export { formatMoney, formatPct, describeFix } from "./freight/engine";

export const FIX_LABELS: Record<SuggestedFix, string> = {
  none: "No change needed",
  reprice: "Reprice",
  surcharge: "Freight surcharge",
  showroom_or_delist: "Showroom only or Delist",
};

export const MISSING_LABELS: Record<string, string> = {
  price: "Price",
  unit_cost: "Unit cost",
  dimensions: "Box dimensions",
};

export function formatDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return "Never";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** Links to the product in Shopify admin, opened outside the app iframe. */
export const adminProductUrl = (productGid: string) =>
  `shopify://admin/products/${productGid.split("/").pop()}`;

/** Downloads a CSV from one of the app's authenticated routes. */
export async function downloadCsv(path: string, filename: string) {
  // Inside the embedded admin, App Bridge adds the session token to fetch.
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
