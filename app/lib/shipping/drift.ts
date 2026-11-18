/**
 * Compares which products should be in the freight shipping profile with
 * which profile their variants are actually in. Pure: no Shopify, no database.
 *
 * A product belongs in the freight profile when its Shipping Method metafield
 * (custom.shipping_method) is "Motor Freight" OR it has the tag "motorfreight".
 * Everything else (including Oversize) belongs elsewhere. Changed 2026-11-18:
 * Oversize used to count too.
 */
import { createHash } from "node:crypto";

/** Shipping Method values whose products belong in the freight profile. */
export const FREIGHT_METHODS = ["Motor Freight"] as const;
/** Product tags (case-insensitive) whose products belong in the freight profile. */
export const FREIGHT_TAGS = ["motorfreight"] as const;
/** Default name of the freight profile; the profile is found by ID when FREIGHT_PROFILE_ID is set. */
export const FREIGHT_PROFILE_NAME = "US Motor Freight";
/** Profiles the app never moves products out of (Shopify Collective manages its own). */
export const PROTECTED_PROFILES = ["Shopify Collective"];

export interface VariantRow {
  variantId: string;
  variantTitle: string;
  productId: string;
  productTitle: string;
  status: string;
  shippingMethod: string | null;
  /** Product tags. */
  tags: string[];
  requiresShipping: boolean;
  profileId: string | null;
  profileName: string | null;
}

export interface FreightProfile {
  id: string;
  name: string;
  rates: RateDefinition[];
}

export interface DriftItem {
  variantId: string;
  productId: string;
  title: string;
  shippingMethod: string | null;
  /** True when the product has a freight tag (e.g. "motorfreight"). */
  freightTag: boolean;
  profileName: string | null;
}

export interface RateCondition {
  field: string;
  operator: string;
  amount: number | null;
}
export interface RateDefinition {
  name: string;
  active: boolean;
  price: number | null;
  conditions: RateCondition[];
}

export interface Drift {
  counts: {
    variants: number;
    byMethod: Record<string, number>;
    inFreight: number;
    /** Variants whose product is tagged motorfreight or is Motor Freight. */
    belongInFreight: number;
    /** Name of the freight profile at check time, or null if not found. */
    profileName: string | null;
  };
  /** Belongs in freight, ships, not in the freight profile. */
  toAdd: DriftItem[];
  /** In the freight profile but doesn't belong there. */
  toRemove: DriftItem[];
  /** Belongs in freight but "not a physical product", so no profile applies. */
  notPhysical: DriftItem[];
  /** Belongs in freight but in a profile the app won't touch. */
  protectedProfile: DriftItem[];
  /** Plain-language problems with the Freight profile's rates. */
  rateWarnings: string[];
  /** Changes when anything above, or any product's tag or profile, changes. */
  fingerprint: string;
}

const isFreightMethod = (m: string | null) => m != null && (FREIGHT_METHODS as readonly string[]).includes(m);
export const hasFreightTag = (tags: string[]) =>
  tags.some((t) => (FREIGHT_TAGS as readonly string[]).includes(t.trim().toLowerCase()));
/** True when a product belongs in the freight profile. */
export const belongsInFreight = (v: Pick<VariantRow, "shippingMethod" | "tags">) =>
  isFreightMethod(v.shippingMethod) || hasFreightTag(v.tags);

const item = (v: VariantRow): DriftItem => ({
  variantId: v.variantId,
  productId: v.productId,
  title: v.variantTitle && v.variantTitle !== "Default Title" ? `${v.productTitle} – ${v.variantTitle}` : v.productTitle,
  shippingMethod: v.shippingMethod,
  freightTag: hasFreightTag(v.tags),
  profileName: v.profileName,
});

const byTitle = (a: DriftItem, b: DriftItem) => a.title.localeCompare(b.title) || a.variantId.localeCompare(b.variantId);

/**
 * `profile` is the freight profile (found by ID or name), or null if the store
 * has none. Variants are matched to it by profile ID, so renaming the profile
 * in Shopify doesn't break the check.
 */
export function computeDrift(rows: VariantRow[], profile: FreightProfile | null): Drift {
  const toAdd: DriftItem[] = [];
  const toRemove: DriftItem[] = [];
  const notPhysical: DriftItem[] = [];
  const protectedProfile: DriftItem[] = [];
  const byMethod: Record<string, number> = {};
  let inFreight = 0;
  let belongInFreight = 0;

  for (const v of rows) {
    const method = v.shippingMethod ?? "Not set";
    byMethod[method] = (byMethod[method] ?? 0) + 1;
    const freight = belongsInFreight(v);
    if (freight) belongInFreight++;
    const inFreightProfile = profile != null && v.profileId === profile.id;
    if (inFreightProfile) inFreight++;

    if (freight) {
      if (!v.requiresShipping) {
        if (v.status === "ACTIVE") notPhysical.push(item(v));
      } else if (!inFreightProfile) {
        if (v.profileName && PROTECTED_PROFILES.includes(v.profileName)) protectedProfile.push(item(v));
        else toAdd.push(item(v));
      }
    } else if (inFreightProfile) {
      toRemove.push(item(v));
    }
  }

  const rateWarnings =
    profile == null
      ? [`There is no shipping profile named "${FREIGHT_PROFILE_NAME}" (or with the ID in FREIGHT_PROFILE_ID).`]
      : checkRates(profile.rates, profile.name);

  // Fingerprint the state that matters: every variant's tag, profile and
  // shipping flag, plus the rate warnings. Same fingerprint = nothing changed.
  const hash = createHash("sha256");
  for (const v of [...rows].sort((a, b) => a.variantId.localeCompare(b.variantId))) {
    hash.update(
      `${v.variantId}|${v.shippingMethod ?? ""}|${hasFreightTag(v.tags) ? 1 : 0}|${v.profileId ?? ""}|${v.requiresShipping ? 1 : 0}|${v.status}\n`,
    );
  }
  hash.update(rateWarnings.join("\n"));

  return {
    counts: { variants: rows.length, byMethod, inFreight, belongInFreight, profileName: profile?.name ?? null },
    toAdd: toAdd.sort(byTitle),
    toRemove: toRemove.sort(byTitle),
    notPhysical: notPhysical.sort(byTitle),
    protectedProfile: protectedProfile.sort(byTitle),
    rateWarnings,
    fingerprint: hash.digest("hex"),
  };
}

/**
 * Finds order-total gaps in the freight profile's price-based rates. A cart
 * whose Freight items total falls in a gap gets no shipping option at all.
 */
export function checkRates(rates: RateDefinition[], profileName = FREIGHT_PROFILE_NAME): string[] {
  const active = rates.filter((r) => r.active);
  if (active.length === 0) return [`${profileName} has no active rates, so its products can't be shipped.`];

  const ranges: Array<[number, number]> = [];
  for (const r of active) {
    const price = r.conditions.filter((c) => c.field === "TOTAL_PRICE");
    if (r.conditions.some((c) => c.field !== "TOTAL_PRICE")) continue; // weight-based: not checked
    const min = price.find((c) => c.operator === "GREATER_THAN_OR_EQUAL_TO")?.amount ?? 0;
    const max = price.find((c) => c.operator === "LESS_THAN_OR_EQUAL_TO")?.amount ?? Infinity;
    ranges.push([min, max]);
  }
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => a[0] - b[0]);

  const warnings: string[] = [];
  const fmt = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  let covered = 0;
  if (ranges[0][0] > 0.01) warnings.push(`${profileName} has no rate for orders under ${fmt(ranges[0][0])}.`);
  covered = ranges[0][1];
  for (const [min, max] of ranges.slice(1)) {
    if (min - covered > 0.011) warnings.push(`${profileName} has no rate for orders between ${fmt(covered)} and ${fmt(min)}.`);
    covered = Math.max(covered, max);
  }
  if (covered !== Infinity) {
    warnings.push(`${profileName} has no rate for orders over ${fmt(covered)}, so those carts can't check out.`);
  }
  return warnings;
}

/** True when the check found something someone should act on. */
export function needsAttention(d: Pick<Drift, "toAdd" | "toRemove" | "notPhysical" | "protectedProfile" | "rateWarnings">) {
  return d.toAdd.length + d.toRemove.length + d.notPhysical.length + d.protectedProfile.length + d.rateWarnings.length > 0;
}
