/**
 * Turns raw Shopify values (strings, metafield JSON, weight units) into the
 * plain numbers the freight engine expects. Pure functions, safe to unit test.
 */

const LB_PER: Record<string, number> = {
  POUNDS: 1,
  OUNCES: 1 / 16,
  KILOGRAMS: 2.2046226218,
  GRAMS: 0.0022046226218,
};

/** Shopify inventory item weight → pounds. */
export function weightToLb(
  weight: { value: number | string | null; unit: string | null } | null | undefined,
): number | null {
  if (!weight || weight.value == null || weight.unit == null) return null;
  const v = Number(weight.value);
  const factor = LB_PER[weight.unit.toUpperCase()];
  if (!Number.isFinite(v) || factor == null) return null;
  return v * factor;
}

const IN_PER: Record<string, number> = {
  in: 1,
  inches: 1,
  inch: 1,
  ft: 12,
  feet: 12,
  yd: 36,
  cm: 1 / 2.54,
  mm: 1 / 25.4,
  m: 39.3700787,
};

/**
 * A dimension metafield value → inches. Accepts a plain number
 * (`number_decimal` / `number_integer`) or a `dimension` JSON value like
 * `{"value": 30, "unit": "cm"}`.
 */
export function parseDimension(raw: string | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  try {
    const j = JSON.parse(raw) as { value?: unknown; unit?: unknown };
    const v = Number(j.value);
    const factor = IN_PER[String(j.unit ?? "in").toLowerCase()];
    if (Number.isFinite(v) && factor != null) return v * factor;
  } catch {
    // fall through
  }
  return null;
}

/**
 * A money metafield value → dollars. Accepts a plain number or a `money`
 * JSON value like `{"amount": "250.00", "currency_code": "USD"}`.
 */
export function parseMoney(raw: string | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  try {
    const j = JSON.parse(raw) as { amount?: unknown };
    const v = Number(j.amount);
    if (Number.isFinite(v)) return v;
  } catch {
    // fall through
  }
  return null;
}

/** An integer metafield value → number, or null. */
export function parseCount(raw: string | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function parseNumber(raw: string | number | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
