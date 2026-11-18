/**
 * The audit log is append only. This module only ever inserts and reads.
 * Do not add update or delete helpers here: the database also rejects them.
 */
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";

export type Actor = { id: string; name: string };

export const SYSTEM_ACTOR: Actor = { id: "system", name: "System" };

export const EVENT_TYPES = {
  scanStarted: "scan_started",
  scanFinished: "scan_finished",
  scanFailed: "scan_failed",
  flagWritten: "flag_written",
  settingsChanged: "settings_changed",
  roleChanged: "role_changed",
  staffAdded: "staff_added",
  priceListImported: "price_list_imported",
  priceListCheckFailed: "price_list_check_failed",
  priceListSourceChanged: "price_list_source_changed",
  shippingCheckChanged: "shipping_check_changed",
  shippingMovedToFreight: "shipping_moved_to_freight",
  shippingRemovedFromFreight: "shipping_removed_from_freight",
  notificationSent: "notification_sent",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export { EVENT_LABELS } from "./labels";

export interface AuditEntry {
  shop: string;
  actor: Actor;
  eventType: EventType;
  productId?: string | null;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  inputs?: Prisma.InputJsonValue | null;
  reason?: string | null;
}

function toRow(e: AuditEntry): Prisma.AuditLogCreateManyInput {
  return {
    shop: e.shop,
    actorId: e.actor.id,
    actorName: e.actor.name,
    eventType: e.eventType,
    productId: e.productId ?? null,
    before: e.before ?? undefined,
    after: e.after ?? undefined,
    inputs: e.inputs ?? undefined,
    reason: e.reason ?? null,
  };
}

type Db = Pick<typeof prisma, "auditLog">;

export async function appendAudit(e: AuditEntry, db: Db = prisma) {
  await db.auditLog.create({ data: toRow(e) });
}

export async function appendAuditMany(entries: AuditEntry[], db: Db = prisma) {
  if (entries.length === 0) return;
  await db.auditLog.createMany({ data: entries.map(toRow) });
}

export interface AuditFilter {
  actorId?: string;
  productId?: string;
  eventType?: string;
  from?: Date;
  to?: Date;
}

export function auditWhere(shop: string, f: AuditFilter): Prisma.AuditLogWhereInput {
  return {
    shop,
    ...(f.actorId ? { actorId: f.actorId } : {}),
    ...(f.productId ? { productId: f.productId } : {}),
    ...(f.eventType ? { eventType: f.eventType } : {}),
    ...(f.from || f.to
      ? { at: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } }
      : {}),
  };
}

export async function listAudit(shop: string, f: AuditFilter, take = 200, skip = 0) {
  return prisma.auditLog.findMany({
    where: auditWhere(shop, f),
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take,
    skip,
  });
}
