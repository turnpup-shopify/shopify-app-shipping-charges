/**
 * Turns one JSONL line from the variant bulk query into engine inputs.
 * Pure, so it can be unit tested without Shopify.
 */
import type { VariantInputs } from "../freight/engine";
import { parseCount, parseDimension, parseMoney, parseNumber, weightToLb } from "../freight/parse";

interface MetafieldValue {
  value: string | null;
}

export interface BulkVariantLine {
  id: string;
  title?: string | null;
  sku?: string | null;
  price?: string | null;
  compareAtPrice?: string | null;
  product?: {
    id: string;
    title: string;
    status?: string;
    featuredMedia?: { preview?: { image?: { url?: string | null } | null } | null } | null;
  } | null;
  inventoryItem?: {
    requiresShipping?: boolean | null;
    unitCost?: { amount: string | number } | null;
    measurement?: { weight?: { value: number | string; unit: string } | null } | null;
  } | null;
  boxLength?: MetafieldValue | null;
  boxWidth?: MetafieldValue | null;
  boxHeight?: MetafieldValue | null;
  boxCount?: MetafieldValue | null;
  overrideCost?: MetafieldValue | null;
  map?: MetafieldValue | null;
}

export interface ParsedVariant {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string | null;
  sku: string | null;
  imageUrl: string | null;
  requiresShipping: boolean;
  inputs: VariantInputs;
  /** The raw metafield strings, kept in the flag snapshot. */
  rawMetafields: Record<string, string | null>;
}

const mf = (m: MetafieldValue | null | undefined) => m?.value ?? null;

export function parseVariantLine(line: BulkVariantLine): ParsedVariant | null {
  if (!line?.id || !line.product?.id) return null;
  const raw = {
    "freight.box_length": mf(line.boxLength),
    "freight.box_width": mf(line.boxWidth),
    "freight.box_height": mf(line.boxHeight),
    "freight.box_count": mf(line.boxCount),
    "freight.override_cost": mf(line.overrideCost),
    "pricing.map": mf(line.map),
  };
  const variantTitle = line.title && line.title !== "Default Title" ? line.title : null;
  return {
    variantId: line.id,
    productId: line.product.id,
    productTitle: line.product.title,
    variantTitle,
    sku: line.sku || null,
    imageUrl: line.product.featuredMedia?.preview?.image?.url ?? null,
    requiresShipping: line.inventoryItem?.requiresShipping !== false,
    rawMetafields: raw,
    inputs: {
      price: parseNumber(line.price),
      compareAtPrice: parseNumber(line.compareAtPrice),
      unitCost: parseNumber(line.inventoryItem?.unitCost?.amount ?? null),
      weightLb: weightToLb(line.inventoryItem?.measurement?.weight ?? null),
      boxLength: parseDimension(raw["freight.box_length"]),
      boxWidth: parseDimension(raw["freight.box_width"]),
      boxHeight: parseDimension(raw["freight.box_height"]),
      boxCount: parseCount(raw["freight.box_count"]),
      overrideCost: parseMoney(raw["freight.override_cost"]),
      map: parseMoney(raw["pricing.map"]),
    },
  };
}

/** Shopify GID → numeric id, for URLs. */
export const gidToId = (gid: string) => gid.split("/").pop() ?? gid;
