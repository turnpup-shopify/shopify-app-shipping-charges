/**
 * Freight Margin Guard settings. Every value here is editable on the
 * Settings screen and stored as a new `settings_version` row on each change.
 */

export interface FreightTier {
  /** Stable key, used in flags and CSV exports. */
  key: string;
  /** Plain-English name shown to users. */
  name: string;
  /** Flat freight cost in dollars for one box in this tier. */
  cost: number;
  /**
   * An item fits this tier only if it is at or under every limit below.
   * `null` means "no limit". The last tier is the catch-all and its limits
   * are ignored.
   */
  maxSize: number | null;
  maxBillableWeight: number | null;
  maxLongestSide: number | null;
}

export interface FreightSettings {
  /** Margin we aim for when suggesting a price or surcharge (0.25 = 25%). */
  targetMargin: number;
  /** Flag anything with margin after freight under this (0.20 = 20%). */
  flagThreshold: number;
  /** Mark as critical when margin after freight is under this (0 = 0%). */
  criticalThreshold: number;
  /** Largest store-wide discount to test against (0.10 = 10%). */
  maxDiscount: number;
  /** Dimensional weight divisor (L × W × H ÷ divisor). */
  dimDivisor: number;
  /** Reprice is suggested if the price increase is at or under this (0.35 = 35%). */
  repriceMaxIncrease: number;
  /** Freight surcharge is suggested if it is at or under this many dollars. */
  surchargeMax: number;
  /**
   * When true, `freight.override_cost` is a per-box cost and is multiplied by
   * box count. When false, it is the total freight for one unit.
   */
  overrideIsPerBox: boolean;
  /** Tiers from smallest to largest. The last one is the catch-all. */
  tiers: FreightTier[];
}

export const DEFAULT_TIERS: FreightTier[] = [
  {
    key: "parcel",
    name: "Parcel",
    cost: 25,
    maxSize: 130,
    maxBillableWeight: 50,
    maxLongestSide: 108,
  },
  {
    key: "large_parcel",
    name: "Large parcel",
    cost: 120,
    maxSize: 165,
    maxBillableWeight: 150,
    maxLongestSide: 108,
  },
  {
    key: "ltl",
    name: "Freight (LTL)",
    cost: 250,
    maxSize: null,
    maxBillableWeight: null,
    maxLongestSide: null,
  },
];

export const DEFAULT_SETTINGS: FreightSettings = {
  targetMargin: 0.25,
  flagThreshold: 0.2,
  criticalThreshold: 0,
  maxDiscount: 0.1,
  dimDivisor: 139,
  repriceMaxIncrease: 0.35,
  surchargeMax: 150,
  overrideIsPerBox: false,
  tiers: DEFAULT_TIERS,
};

/** Returns a list of problems, empty when the settings are usable. */
export function validateSettings(s: FreightSettings): string[] {
  const errors: string[] = [];
  const pct = (v: number) => Number.isFinite(v) && v >= -1 && v < 1;
  if (!pct(s.targetMargin) || s.targetMargin <= 0)
    errors.push("Target margin must be between 0% and 100%.");
  if (!pct(s.flagThreshold)) errors.push("Flag threshold must be under 100%.");
  if (!pct(s.criticalThreshold))
    errors.push("Critical threshold must be under 100%.");
  if (s.criticalThreshold > s.flagThreshold)
    errors.push("Critical threshold must be at or under the flag threshold.");
  if (!Number.isFinite(s.maxDiscount) || s.maxDiscount < 0 || s.maxDiscount >= 1)
    errors.push("Max discount must be between 0% and 100%.");
  if (!Number.isFinite(s.dimDivisor) || s.dimDivisor <= 0)
    errors.push("Dimensional weight divisor must be above 0.");
  if (!Number.isFinite(s.repriceMaxIncrease) || s.repriceMaxIncrease < 0)
    errors.push("Reprice limit must be 0% or more.");
  if (!Number.isFinite(s.surchargeMax) || s.surchargeMax < 0)
    errors.push("Surcharge limit must be $0 or more.");
  if (s.tiers.length < 1) errors.push("At least one freight tier is needed.");
  s.tiers.forEach((t, i) => {
    if (!t.name.trim()) errors.push(`Tier ${i + 1} needs a name.`);
    if (!Number.isFinite(t.cost) || t.cost < 0)
      errors.push(`${t.name || `Tier ${i + 1}`}: cost must be $0 or more.`);
  });
  return errors;
}
