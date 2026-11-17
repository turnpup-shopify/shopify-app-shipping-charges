/**
 * The freight and margin math. Pure functions only: no Shopify, no database.
 * Money is handled in whole cents to avoid floating point drift.
 *
 * Every result carries `lines`, a receipt-style explanation that the UI shows
 * when someone clicks a number.
 */
import type { FreightSettings, FreightTier } from "./settings";

export interface VariantInputs {
  /** Variant price in dollars. */
  price: number | null;
  compareAtPrice: number | null;
  /** Inventory item unit cost in dollars. */
  unitCost: number | null;
  /** Total shipping weight of one unit, in pounds. */
  weightLb: number | null;
  /** Box dimensions in inches, from `freight.box_*` metafields. */
  boxLength: number | null;
  boxWidth: number | null;
  boxHeight: number | null;
  /** Number of boxes one unit ships in. Defaults to 1. */
  boxCount: number | null;
  /** `freight.override_cost` in dollars. */
  overrideCost: number | null;
  /** `pricing.map` in dollars. */
  map: number | null;
}

export type MissingInput = "price" | "unit_cost" | "dimensions";
export type Severity = "ok" | "flagged" | "critical";
export type SuggestedFix = "none" | "reprice" | "surcharge" | "showroom_or_delist";

export interface FreightBreakdown {
  source: "manual" | "tier";
  tierKey: string | null;
  tierName: string;
  boxCount: number;
  perBoxCents: number;
  totalCents: number;
  /** Per-box measurements. Null when freight is manual and no dimensions exist. */
  size: number | null;
  longestSide: number | null;
  dimWeight: number | null;
  actualWeightPerBox: number | null;
  billableWeight: number | null;
}

export interface ReceiptLine {
  key: string;
  label: string;
  /** Display value, already formatted. */
  value: string;
  /** Plain-English explanation of how the value was worked out. */
  how: string;
  /** Visual emphasis for totals and results. */
  emphasis?: "total" | "bad" | "good";
}

export interface EvaluationComplete {
  status: "complete";
  warnings: string[];
  freight: FreightBreakdown;
  priceCents: number;
  unitCostCents: number;
  landedCostCents: number;
  marginCents: number;
  marginPct: number;
  discountPriceCents: number;
  marginAtDiscountCents: number;
  marginAtDiscountPct: number;
  severity: Severity;
  suggestedPriceCents: number;
  priceIncreasePct: number;
  suggestedSurchargeCents: number;
  suggestedFix: SuggestedFix;
  excludeFromDiscounts: boolean;
  /** Dollar figure that goes with the fix (new price or surcharge), in cents. */
  suggestedValueCents: number | null;
  lines: ReceiptLine[];
}

export interface EvaluationIncomplete {
  status: "incomplete";
  missing: MissingInput[];
  warnings: string[];
  /** Freight is filled in when it could be worked out. */
  freight: FreightBreakdown | null;
  lines: ReceiptLine[];
}

export type Evaluation = EvaluationComplete | EvaluationIncomplete;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export const toCents = (dollars: number) => Math.round(dollars * 100);

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  const abs = Math.abs(cents) / 100;
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatPct(fraction: number, digits = 1, signed = false): string {
  if (!Number.isFinite(fraction)) return "n/a";
  const v = fraction * 100;
  const rounded = Number(v.toFixed(digits));
  const sign = rounded < 0 ? "−" : rounded > 0 && signed ? "+" : "";
  return `${sign}${Math.abs(rounded).toFixed(digits)}%`;
}

const num = (v: number, digits = 1) =>
  Number.isInteger(v) ? String(v) : v.toFixed(digits);

/**
 * Round a price up to the next whole dollar amount ending in 9.
 * 516.00 → 519, 519.00 → 519, 519.01 → 529, 520 → 529.
 */
export function roundUpToNine(cents: number): number {
  const dollars = Math.ceil(cents / 100);
  const ending = ((dollars % 10) + 10) % 10;
  const add = (9 - ending + 10) % 10;
  return (dollars + add) * 100;
}

// ---------------------------------------------------------------------------
// Freight
// ---------------------------------------------------------------------------

export interface PackageMeasure {
  size: number;
  longestSide: number;
  dimWeight: number;
  actualWeightPerBox: number | null;
  billableWeight: number;
}

/** Size, dimensional weight and billable weight for one box. */
export function measureBox(
  l: number,
  w: number,
  h: number,
  actualWeightPerBox: number | null,
  dimDivisor: number,
): PackageMeasure {
  const sides = [l, w, h].sort((a, b) => b - a);
  const [longest, mid, short] = sides;
  // Size = length + 2 × width + 2 × height, where length is the longest side.
  const size = longest + 2 * mid + 2 * short;
  const dimWeight = (l * w * h) / dimDivisor;
  const billableWeight = Math.max(actualWeightPerBox ?? 0, dimWeight);
  return { size, longestSide: longest, dimWeight, actualWeightPerBox, billableWeight };
}

/** First tier the box fits in. The last tier is the catch-all. */
export function pickTier(m: PackageMeasure, tiers: FreightTier[]): FreightTier {
  for (let i = 0; i < tiers.length - 1; i++) {
    const t = tiers[i];
    const fits =
      (t.maxSize == null || m.size <= t.maxSize) &&
      (t.maxBillableWeight == null || m.billableWeight <= t.maxBillableWeight) &&
      (t.maxLongestSide == null || m.longestSide <= t.maxLongestSide);
    if (fits) return t;
  }
  return tiers[tiers.length - 1];
}

/** Explains why a box landed in its tier, in plain words. */
export function tierReason(m: PackageMeasure, tier: FreightTier, tiers: FreightTier[]): string {
  const idx = tiers.findIndex((t) => t.key === tier.key);
  const isLast = idx === tiers.length - 1;
  if (!isLast) {
    const parts = [`size ${num(m.size)} in`];
    if (tier.maxSize != null) parts[0] += ` (limit ${tier.maxSize})`;
    parts.push(
      `billable ${num(m.billableWeight)} lb` +
        (tier.maxBillableWeight != null ? ` (limit ${tier.maxBillableWeight})` : ""),
    );
    if (tier.maxLongestSide != null)
      parts.push(`longest side ${num(m.longestSide)} in (limit ${tier.maxLongestSide})`);
    return `Fits ${tier.name}: ${parts.join(", ")}.`;
  }
  // Catch-all: say which smaller-tier limit it broke.
  const prev = tiers[tiers.length - 2];
  if (!prev) return `${tier.name} is the only tier.`;
  const reasons: string[] = [];
  if (prev.maxSize != null && m.size > prev.maxSize)
    reasons.push(`size ${num(m.size)} in is over ${prev.maxSize}`);
  if (prev.maxBillableWeight != null && m.billableWeight > prev.maxBillableWeight)
    reasons.push(`billable weight ${num(m.billableWeight)} lb is over ${prev.maxBillableWeight}`);
  if (prev.maxLongestSide != null && m.longestSide > prev.maxLongestSide)
    reasons.push(`longest side ${num(m.longestSide)} in is over ${prev.maxLongestSide}`);
  return `${tier.name} because ${reasons.join(", and ")}.`;
}

// ---------------------------------------------------------------------------
// Main evaluation
// ---------------------------------------------------------------------------

const present = (v: number | null | undefined): v is number =>
  v != null && Number.isFinite(v);

export function evaluateVariant(input: VariantInputs, s: FreightSettings): Evaluation {
  const warnings: string[] = [];
  const lines: ReceiptLine[] = [];
  const missing: MissingInput[] = [];

  // --- Box count -----------------------------------------------------------
  let boxCount = 1;
  if (present(input.boxCount)) {
    if (input.boxCount >= 1 && Number.isInteger(input.boxCount)) boxCount = input.boxCount;
    else warnings.push(`Box count "${input.boxCount}" is not a whole number of 1 or more, so 1 was used.`);
  }

  // --- Freight -------------------------------------------------------------
  const hasDims =
    present(input.boxLength) && present(input.boxWidth) && present(input.boxHeight) &&
    input.boxLength! > 0 && input.boxWidth! > 0 && input.boxHeight! > 0;

  let measure: PackageMeasure | null = null;
  if (hasDims) {
    const perBoxWeight = present(input.weightLb) && input.weightLb > 0 ? input.weightLb / boxCount : null;
    if (perBoxWeight == null)
      warnings.push("Weight is missing, so billable weight uses dimensional weight only.");
    measure = measureBox(input.boxLength!, input.boxWidth!, input.boxHeight!, perBoxWeight, s.dimDivisor);
  }

  let freight: FreightBreakdown | null = null;
  if (present(input.overrideCost) && input.overrideCost >= 0) {
    const overrideCents = toCents(input.overrideCost);
    const perBox = s.overrideIsPerBox ? overrideCents : Math.round(overrideCents / boxCount);
    const total = s.overrideIsPerBox ? overrideCents * boxCount : overrideCents;
    freight = {
      source: "manual",
      tierKey: null,
      tierName: "Manual",
      boxCount,
      perBoxCents: perBox,
      totalCents: total,
      size: measure?.size ?? null,
      longestSide: measure?.longestSide ?? null,
      dimWeight: measure?.dimWeight ?? null,
      actualWeightPerBox: measure?.actualWeightPerBox ?? null,
      billableWeight: measure?.billableWeight ?? null,
    };
  } else if (measure) {
    const tier = pickTier(measure, s.tiers);
    const perBox = toCents(tier.cost);
    freight = {
      source: "tier",
      tierKey: tier.key,
      tierName: tier.name,
      boxCount,
      perBoxCents: perBox,
      totalCents: perBox * boxCount,
      size: measure.size,
      longestSide: measure.longestSide,
      dimWeight: measure.dimWeight,
      actualWeightPerBox: measure.actualWeightPerBox,
      billableWeight: measure.billableWeight,
    };
  } else {
    missing.push("dimensions");
  }

  if (!present(input.price) || input.price <= 0) missing.push("price");
  if (!present(input.unitCost) || input.unitCost < 0) missing.push("unit_cost");

  // Freight lines are useful even when other inputs are missing.
  if (freight) lines.push(...freightLines(freight, measure, s, input));

  if (missing.length > 0) {
    // Keep a stable order for display.
    const order: MissingInput[] = ["price", "unit_cost", "dimensions"];
    missing.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return { status: "incomplete", missing, warnings, freight, lines };
  }

  const f = freight!;
  const priceCents = toCents(input.price!);
  const unitCostCents = toCents(input.unitCost!);
  const mapCents = present(input.map) && input.map > 0 ? toCents(input.map) : null;

  // --- Margin --------------------------------------------------------------
  const landedCostCents = unitCostCents + f.totalCents;
  const marginCents = priceCents - landedCostCents;
  const marginPct = marginCents / priceCents;

  const discountPriceCents = Math.round(priceCents * (1 - s.maxDiscount));
  const marginAtDiscountCents = discountPriceCents - landedCostCents;
  const marginAtDiscountPct = discountPriceCents > 0 ? marginAtDiscountCents / discountPriceCents : -Infinity;

  const severity: Severity =
    marginPct < s.criticalThreshold ? "critical" : marginPct < s.flagThreshold ? "flagged" : "ok";

  // --- Suggestions ---------------------------------------------------------
  const targetPriceCents = Math.ceil(landedCostCents / (1 - s.targetMargin));
  const floorCents = Math.max(mapCents ?? 0, targetPriceCents);
  const suggestedPriceCents = roundUpToNine(floorCents);
  const priceIncreasePct = (suggestedPriceCents - priceCents) / priceCents;
  const suggestedSurchargeCents = Math.max(
    0,
    landedCostCents - Math.round(priceCents * (1 - s.targetMargin)),
  );

  let suggestedFix: SuggestedFix = "none";
  let suggestedValueCents: number | null = null;
  let excludeFromDiscounts = false;
  if (severity !== "ok") {
    if (priceIncreasePct <= s.repriceMaxIncrease + 1e-9) {
      suggestedFix = "reprice";
      suggestedValueCents = suggestedPriceCents;
    } else if (suggestedSurchargeCents <= toCents(s.surchargeMax)) {
      suggestedFix = "surcharge";
      suggestedValueCents = suggestedSurchargeCents;
    } else {
      suggestedFix = "showroom_or_delist";
    }
  }
  if (marginAtDiscountPct < 0) excludeFromDiscounts = true;

  // --- Receipt -------------------------------------------------------------
  lines.push(
    {
      key: "unit_cost",
      label: "Unit cost",
      value: formatMoney(unitCostCents),
      how: "What we pay for one unit, from the inventory item's cost in Shopify.",
    },
    {
      key: "landed_cost",
      label: "Landed cost",
      value: formatMoney(landedCostCents),
      how: `Unit cost ${formatMoney(unitCostCents)} + freight ${formatMoney(f.totalCents)}.`,
      emphasis: "total",
    },
    {
      key: "price",
      label: "Price",
      value: formatMoney(priceCents),
      how: "The variant's current selling price in Shopify.",
    },
    {
      key: "margin",
      label: "Margin after freight",
      value: `${formatMoney(marginCents)} (${formatPct(marginPct)})`,
      how: `Price ${formatMoney(priceCents)} − landed cost ${formatMoney(landedCostCents)} = ${formatMoney(marginCents)}. Divided by price: ${formatMoney(marginCents)} ÷ ${formatMoney(priceCents)} = ${formatPct(marginPct)}.`,
      emphasis: marginCents < 0 ? "bad" : severity === "ok" ? "good" : undefined,
    },
    {
      key: "margin_at_discount",
      label: `Margin at ${formatPct(s.maxDiscount, 0)} off`,
      value: `${formatMoney(marginAtDiscountCents)} (${formatPct(marginAtDiscountPct)})`,
      how: `Discounted price ${formatMoney(priceCents)} × (1 − ${formatPct(s.maxDiscount, 0)}) = ${formatMoney(discountPriceCents)}. Minus landed cost ${formatMoney(landedCostCents)} = ${formatMoney(marginAtDiscountCents)}. Divided by the discounted price = ${formatPct(marginAtDiscountPct)}.`,
      emphasis: marginAtDiscountCents < 0 ? "bad" : undefined,
    },
    {
      key: "severity",
      label: "Status",
      value: severity === "critical" ? "Critical" : severity === "flagged" ? "Flagged" : "OK",
      how: `Critical when margin is under ${formatPct(s.criticalThreshold, 0)}. Flagged when under ${formatPct(s.flagThreshold, 0)}. This one is ${formatPct(marginPct)}.`,
      emphasis: severity === "ok" ? "good" : "bad",
    },
    {
      key: "suggested_price",
      label: "Suggested price",
      value: formatMoney(suggestedPriceCents),
      how:
        `To hit a ${formatPct(s.targetMargin, 0)} margin: landed cost ${formatMoney(landedCostCents)} ÷ (1 − ${formatPct(s.targetMargin, 0)}) = ${formatMoney(targetPriceCents)}.` +
        (mapCents != null
          ? ` MAP is ${formatMoney(mapCents)}, so the floor is the higher of the two: ${formatMoney(floorCents)}.`
          : " No MAP is set.") +
        ` Rounded up to a price ending in 9: ${formatMoney(suggestedPriceCents)}.`,
    },
    {
      key: "price_increase",
      label: "Price increase",
      value: formatPct(priceIncreasePct, 0, true),
      how: `(${formatMoney(suggestedPriceCents)} − ${formatMoney(priceCents)}) ÷ ${formatMoney(priceCents)} = ${formatPct(priceIncreasePct)}.`,
    },
    {
      key: "suggested_surcharge",
      label: "Suggested surcharge",
      value: formatMoney(suggestedSurchargeCents),
      how: `Landed cost ${formatMoney(landedCostCents)} − price × (1 − ${formatPct(s.targetMargin, 0)}) ${formatMoney(Math.round(priceCents * (1 - s.targetMargin)))} = ${formatMoney(suggestedSurchargeCents)}. This is the extra freight charge that would bring the margin back to target without changing the price.`,
    },
    {
      key: "suggested_fix",
      label: "Suggested fix",
      value: describeFix(suggestedFix, excludeFromDiscounts),
      how: fixReason(suggestedFix, severity, priceIncreasePct, suggestedSurchargeCents, excludeFromDiscounts, s),
      emphasis: "total",
    },
  );

  return {
    status: "complete",
    warnings,
    freight: f,
    priceCents,
    unitCostCents,
    landedCostCents,
    marginCents,
    marginPct,
    discountPriceCents,
    marginAtDiscountCents,
    marginAtDiscountPct,
    severity,
    suggestedPriceCents,
    priceIncreasePct,
    suggestedSurchargeCents,
    suggestedFix,
    excludeFromDiscounts,
    suggestedValueCents,
    lines,
  };
}

function freightLines(
  f: FreightBreakdown,
  m: PackageMeasure | null,
  s: FreightSettings,
  input: VariantInputs,
): ReceiptLine[] {
  const out: ReceiptLine[] = [];
  if (m) {
    out.push(
      {
        key: "size",
        label: "Size (per box)",
        value: `${num(m.size)} in`,
        how: `Longest side + 2 × width + 2 × height = ${num(m.longestSide)} + 2 × ${num(
          [input.boxLength!, input.boxWidth!, input.boxHeight!].sort((a, b) => b - a)[1],
        )} + 2 × ${num([input.boxLength!, input.boxWidth!, input.boxHeight!].sort((a, b) => b - a)[2])}.`,
      },
      {
        key: "dim_weight",
        label: "Dimensional weight (per box)",
        value: `${num(m.dimWeight)} lb`,
        how: `${num(input.boxLength!)} × ${num(input.boxWidth!)} × ${num(input.boxHeight!)} ÷ ${s.dimDivisor}.`,
      },
      {
        key: "billable_weight",
        label: "Billable weight (per box)",
        value: `${num(m.billableWeight)} lb`,
        how:
          m.actualWeightPerBox != null
            ? `The larger of actual weight ${num(m.actualWeightPerBox)} lb${
                f.boxCount > 1 ? ` (total weight split across ${f.boxCount} boxes)` : ""
              } and dimensional weight ${num(m.dimWeight)} lb.`
            : `No actual weight on file, so this is the dimensional weight.`,
      },
    );
  }
  if (f.source === "manual") {
    out.push({
      key: "freight",
      label: "Freight (Manual)",
      value: formatMoney(f.totalCents),
      how: s.overrideIsPerBox
        ? `Manual override ${formatMoney(f.perBoxCents)} per box × ${f.boxCount} box${f.boxCount === 1 ? "" : "es"}, from the freight.override_cost metafield. A manual override always wins over the tier.`
        : `Manual override from the freight.override_cost metafield, for the whole unit. A manual override always wins over the tier.`,
      emphasis: "total",
    });
  } else if (m) {
    const tier = s.tiers.find((t) => t.key === f.tierKey)!;
    out.push({
      key: "freight",
      label: `Freight (${f.tierName})`,
      value: formatMoney(f.totalCents),
      how: `${tierReason(m, tier, s.tiers)} ${f.tierName} costs ${formatMoney(f.perBoxCents)} per box × ${f.boxCount} box${f.boxCount === 1 ? "" : "es"}.`,
      emphasis: "total",
    });
  }
  return out;
}

export function describeFix(fix: SuggestedFix, excludeFromDiscounts: boolean): string {
  const base =
    fix === "reprice"
      ? "Reprice"
      : fix === "surcharge"
        ? "Freight surcharge"
        : fix === "showroom_or_delist"
          ? "Showroom only or Delist"
          : "No change needed";
  if (!excludeFromDiscounts) return base;
  return fix === "none" ? "Exclude from discounts" : `${base}, plus Exclude from discounts`;
}

function fixReason(
  fix: SuggestedFix,
  severity: Severity,
  inc: number,
  surchargeCents: number,
  exclude: boolean,
  s: FreightSettings,
): string {
  const parts: string[] = [];
  const lim = formatPct(s.repriceMaxIncrease, 0);
  if (severity === "ok") {
    parts.push("Margin is at or above the flag threshold, so no price fix is needed.");
  } else if (fix === "reprice") {
    parts.push(`The price increase of ${formatPct(inc, 0, true)} is within the ${lim} limit, so reprice.`);
  } else if (fix === "surcharge") {
    parts.push(
      `The price increase of ${formatPct(inc, 0, true)} is over the ${lim} limit. The surcharge of ${formatMoney(surchargeCents)} is within the ${formatMoney(toCents(s.surchargeMax))} limit, so add a freight surcharge.`,
    );
  } else {
    parts.push(
      `The price increase of ${formatPct(inc, 0, true)} is over the ${lim} limit and the surcharge of ${formatMoney(surchargeCents)} is over the ${formatMoney(toCents(s.surchargeMax))} limit, so consider showroom only or delisting.`,
    );
  }
  if (exclude)
    parts.push(
      `It loses money at ${formatPct(s.maxDiscount, 0)} off, so also exclude it from discounts.`,
    );
  return parts.join(" ");
}
