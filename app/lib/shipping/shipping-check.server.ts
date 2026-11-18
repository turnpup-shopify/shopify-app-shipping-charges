/**
 * Reads every variant's Shipping Method and shipping profile from Shopify,
 * stores the result, and (only when a person clicks) moves variants in or out
 * of the Freight profile. Moving is the app's only write to Shopify and needs
 * the write_shipping scope.
 */
import type { Prisma, ScanTrigger, ShippingCheck } from "@prisma/client";
import prisma from "../../db.server";
import { unauthenticated } from "../../shopify.server";
import { appendAudit, EVENT_TYPES, type Actor } from "../audit.server";
import {
  computeDrift,
  FREIGHT_PROFILE_NAME,
  needsAttention,
  type Drift,
  type DriftItem,
  type FreightProfile,
  type RateDefinition,
  type VariantRow,
} from "./drift";

type AdminClient = Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];

const PAGE_SIZE = 100;
const MOVE_BATCH = 250;

const VARIANTS_QUERY = `#graphql
  query ShippingVariants($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        inventoryItem { requiresShipping }
        deliveryProfile { id name }
        product {
          id
          title
          status
          tags
          shippingMethod: metafield(namespace: "custom", key: "shipping_method") { value }
        }
      }
    }
  }`;

const PROFILES_QUERY = `#graphql
  query ShippingProfiles {
    deliveryProfiles(first: 25) {
      nodes {
        id
        name
        profileLocationGroups {
          locationGroupZones(first: 25) {
            nodes {
              methodDefinitions(first: 25) {
                nodes {
                  name
                  active
                  rateProvider { ... on DeliveryRateDefinition { price { amount } } }
                  methodConditions {
                    field
                    operator
                    conditionCriteria { ... on MoneyV2 { amount } }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;

const MOVE_MUTATION = `#graphql
  mutation MoveFreightVariants($id: ID!, $profile: DeliveryProfileInput!) {
    deliveryProfileUpdate(id: $id, profile: $profile) {
      profile { id productVariantsCount { count } }
      userErrors { field message }
    }
  }`;

async function gql<T>(admin: AdminClient, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, { variables });
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

interface VariantNode {
  id: string;
  title: string;
  inventoryItem: { requiresShipping: boolean } | null;
  deliveryProfile: { id: string; name: string } | null;
  product: { id: string; title: string; status: string; tags: string[]; shippingMethod: { value: string } | null };
}

async function readVariants(admin: AdminClient): Promise<VariantRow[]> {
  const rows: VariantRow[] = [];
  let after: string | null = null;
  do {
    const data: {
      productVariants: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: VariantNode[] };
    } = await gql(admin, VARIANTS_QUERY, { first: PAGE_SIZE, after });
    for (const n of data.productVariants.nodes) {
      rows.push({
        variantId: n.id,
        variantTitle: n.title,
        productId: n.product.id,
        productTitle: n.product.title,
        status: n.product.status,
        shippingMethod: n.product.shippingMethod?.value?.trim() || null,
        tags: n.product.tags ?? [],
        requiresShipping: n.inventoryItem?.requiresShipping ?? true,
        profileId: n.deliveryProfile?.id ?? null,
        profileName: n.deliveryProfile?.name ?? null,
      });
    }
    after = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
  } while (after);
  return rows;
}

interface ProfileNode {
  id: string;
  name: string;
  profileLocationGroups: Array<{
    locationGroupZones: {
      nodes: Array<{
        methodDefinitions: {
          nodes: Array<{
            name: string;
            active: boolean;
            rateProvider: { price?: { amount: string } } | null;
            methodConditions: Array<{ field: string; operator: string; conditionCriteria: { amount?: string } | null }>;
          }>;
        };
      }>;
    };
  }>;
}

/**
 * The freight profile: the one whose ID is FREIGHT_PROFILE_ID if that's set,
 * otherwise the one named FREIGHT_PROFILE_NAME. Matching by ID survives renames.
 */
async function readFreightProfile(admin: AdminClient): Promise<FreightProfile | null> {
  const data = await gql<{ deliveryProfiles: { nodes: ProfileNode[] } }>(admin, PROFILES_QUERY);
  const wantId = process.env.FREIGHT_PROFILE_ID?.trim();
  const profile = wantId
    ? data.deliveryProfiles.nodes.find((p) => p.id === wantId || p.id.endsWith(`/${wantId}`))
    : data.deliveryProfiles.nodes.find((p) => p.name === FREIGHT_PROFILE_NAME);
  if (!profile) return null;
  const rates: RateDefinition[] = [];
  for (const g of profile.profileLocationGroups) {
    for (const z of g.locationGroupZones.nodes) {
      for (const m of z.methodDefinitions.nodes) {
        rates.push({
          name: m.name,
          active: m.active,
          price: m.rateProvider?.price ? Number(m.rateProvider.price.amount) : null,
          conditions: m.methodConditions.map((c) => ({
            field: c.field,
            operator: c.operator,
            amount: c.conditionCriteria?.amount != null ? Number(c.conditionCriteria.amount) : null,
          })),
        });
      }
    }
  }
  return { id: profile.id, name: profile.name, rates };
}

export interface CheckOutcome {
  check: ShippingCheck;
  drift: Drift;
  /** True when the state differs from the previous check (or there was none). */
  changed: boolean;
}

/**
 * Reads the live state and stores it. When nothing changed since the last
 * check, it only updates that row's last_seen_at.
 */
export async function runShippingCheck(
  shop: string,
  trigger: ScanTrigger,
  actor: Actor,
  admin?: AdminClient,
): Promise<CheckOutcome> {
  const client = admin ?? (await unauthenticated.admin(shop)).admin;
  const [rows, freight] = await Promise.all([readVariants(client), readFreightProfile(client)]);
  const drift = computeDrift(rows, freight);

  const previous = await prisma.shippingCheck.findFirst({ where: { shop }, orderBy: { checkedAt: "desc" } });
  if (previous && previous.fingerprint === drift.fingerprint) {
    const check = await prisma.shippingCheck.update({ where: { id: previous.id }, data: { lastSeenAt: new Date() } });
    return { check, drift, changed: false };
  }

  const json = (items: DriftItem[]) => items as unknown as Prisma.InputJsonValue;
  const check = await prisma.shippingCheck.create({
    data: {
      shop,
      trigger,
      triggeredById: actor.id,
      triggeredByName: actor.name,
      fingerprint: drift.fingerprint,
      freightProfileId: freight?.id ?? null,
      counts: drift.counts as unknown as Prisma.InputJsonValue,
      toAdd: json(drift.toAdd),
      toRemove: json(drift.toRemove),
      notPhysical: json(drift.notPhysical),
      protectedProfile: json(drift.protectedProfile),
      rateWarnings: drift.rateWarnings,
    },
  });
  if (needsAttention(drift)) {
    await appendAudit({
      shop,
      actor,
      eventType: EVENT_TYPES.shippingCheckChanged,
      after: {
        checkId: check.id,
        toAdd: drift.toAdd.length,
        toRemove: drift.toRemove.length,
        notPhysical: drift.notPhysical.length,
        rateWarnings: drift.rateWarnings.length,
      },
      inputs: { trigger },
    });
  }
  return { check, drift, changed: true };
}

export type MoveKind = "add" | "remove";

/**
 * Re-reads the live state, then moves exactly the variants that are still out
 * of step: "add" puts tagged variants into Freight, "remove" sends untagged
 * ones back to the default profile. Only runs when a person clicks.
 */
export async function moveFreightVariants(shop: string, actor: Actor, admin: AdminClient, kind: MoveKind) {
  const before = await runShippingCheck(shop, "MANUAL", actor, admin);
  const profileId = before.check.freightProfileId;
  if (!profileId) throw new Error(`Couldn't find the freight shipping profile ("${FREIGHT_PROFILE_NAME}" or FREIGHT_PROFILE_ID).`);
  const items = kind === "add" ? before.drift.toAdd : before.drift.toRemove;
  if (items.length === 0) return { moved: 0, after: before };

  const ids = items.map((i) => i.variantId);
  for (let i = 0; i < ids.length; i += MOVE_BATCH) {
    const batch = ids.slice(i, i + MOVE_BATCH);
    const data = await gql<{
      deliveryProfileUpdate: { userErrors: Array<{ field: string[] | null; message: string }> };
    }>(admin, MOVE_MUTATION, {
      id: profileId,
      profile: kind === "add" ? { variantsToAssociate: batch } : { variantsToDissociate: batch },
    });
    const errors = data.deliveryProfileUpdate.userErrors;
    if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
  }

  await appendAudit({
    shop,
    actor,
    eventType: kind === "add" ? EVENT_TYPES.shippingMovedToFreight : EVENT_TYPES.shippingRemovedFromFreight,
    before: { profiles: Object.fromEntries(items.map((i) => [i.variantId, i.profileName])) },
    after: { profile: kind === "add" ? (before.drift.counts.profileName ?? FREIGHT_PROFILE_NAME) : "default profile", count: items.length },
    inputs: { variantIds: ids, titles: items.map((i) => i.title) },
  });

  const after = await runShippingCheck(shop, "MANUAL", actor, admin);
  return { moved: items.length, after };
}

/** The newest stored check for a shop, with its lists typed. */
export async function latestShippingCheck(shop: string) {
  const c = await prisma.shippingCheck.findFirst({ where: { shop }, orderBy: { checkedAt: "desc" } });
  if (!c) return null;
  return {
    id: c.id,
    checkedAt: c.checkedAt.toISOString(),
    lastSeenAt: c.lastSeenAt.toISOString(),
    trigger: c.trigger,
    triggeredByName: c.triggeredByName,
    counts: c.counts as unknown as Drift["counts"],
    toAdd: c.toAdd as unknown as DriftItem[],
    toRemove: c.toRemove as unknown as DriftItem[],
    notPhysical: c.notPhysical as unknown as DriftItem[],
    protectedProfile: c.protectedProfile as unknown as DriftItem[],
    rateWarnings: c.rateWarnings,
  };
}
