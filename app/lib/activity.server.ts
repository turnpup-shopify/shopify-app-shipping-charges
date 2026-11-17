import type { AuditFilter } from "./audit.server";

export function filterFromParams(p: URLSearchParams): AuditFilter & { raw: Record<string, string> } {
  const raw = {
    actor: p.get("actor") ?? "",
    product: p.get("product") ?? "",
    event: p.get("event") ?? "",
    from: p.get("from") ?? "",
    to: p.get("to") ?? "",
  };
  const product = raw.product.trim();
  const productId = !product
    ? undefined
    : product.startsWith("gid://")
      ? product
      : /^\d+$/.test(product)
        ? `gid://shopify/Product/${product}`
        : product;
  // Dates are entered as Central time calendar days.
  const day = (s: string, end: boolean) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
    const d = new Date(`${s}T${end ? "23:59:59.999" : "00:00:00"}${centralOffset(s)}`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  return {
    raw,
    actorId: raw.actor || undefined,
    productId,
    eventType: raw.event || undefined,
    from: day(raw.from, false),
    to: day(raw.to, true),
  };
}

/** UTC offset of US Central time on a given day, e.g. "-06:00" or "-05:00". */
export function centralOffset(isoDay: string): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "shortOffset" })
    .formatToParts(new Date(`${isoDay}T12:00:00Z`))
    .find((p) => p.type === "timeZoneName")?.value; // "GMT-6"
  const m = part?.match(/GMT([+-])(\d+)/);
  if (!m) return "-06:00";
  return `${m[1]}${m[2].padStart(2, "0")}:00`;
}
