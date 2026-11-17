import type { Prisma, SettingsVersion } from "@prisma/client";
import prisma from "../db.server";
import { DEFAULT_SETTINGS, validateSettings, type FreightSettings, type FreightTier } from "./freight/settings";
import { appendAudit, EVENT_TYPES, SYSTEM_ACTOR, type Actor } from "./audit.server";

export function rowToSettings(row: SettingsVersion): FreightSettings {
  return {
    targetMargin: Number(row.targetMargin),
    flagThreshold: Number(row.flagThreshold),
    criticalThreshold: Number(row.criticalThreshold),
    maxDiscount: Number(row.maxDiscount),
    dimDivisor: Number(row.dimDivisor),
    repriceMaxIncrease: Number(row.repriceMaxIncrease),
    surchargeMax: Number(row.surchargeMax),
    overrideIsPerBox: row.overrideIsPerBox,
    tiers: row.tiers as unknown as FreightTier[],
  };
}

function settingsToData(s: FreightSettings) {
  return {
    targetMargin: s.targetMargin,
    flagThreshold: s.flagThreshold,
    criticalThreshold: s.criticalThreshold,
    maxDiscount: s.maxDiscount,
    dimDivisor: s.dimDivisor,
    repriceMaxIncrease: s.repriceMaxIncrease,
    surchargeMax: s.surchargeMax,
    overrideIsPerBox: s.overrideIsPerBox,
    tiers: s.tiers as unknown as Prisma.InputJsonValue,
  };
}

/** The newest settings row for the shop, creating the defaults on first use. */
export async function getCurrentSettingsRow(shop: string): Promise<SettingsVersion> {
  const row = await prisma.settingsVersion.findFirst({
    where: { shop },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (row) return row;
  return prisma.settingsVersion.create({
    data: {
      shop,
      ...settingsToData(DEFAULT_SETTINGS),
      createdById: SYSTEM_ACTOR.id,
      createdByName: SYSTEM_ACTOR.name,
      reason: "Default settings from the Phase 1 spec.",
    },
  });
}

export async function getCurrentSettings(shop: string) {
  const row = await getCurrentSettingsRow(shop);
  return { row, settings: rowToSettings(row) };
}

export async function saveSettings(shop: string, actor: Actor, next: FreightSettings, reason: string) {
  const errors = validateSettings(next);
  if (!reason.trim()) errors.push("A reason is required.");
  if (errors.length) return { ok: false as const, errors };

  const { row: prevRow, settings: prev } = await getCurrentSettings(shop);
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.settingsVersion.create({
      data: {
        shop,
        ...settingsToData(next),
        createdById: actor.id,
        createdByName: actor.name,
        reason: reason.trim(),
      },
    });
    await appendAudit(
      {
        shop,
        actor,
        eventType: EVENT_TYPES.settingsChanged,
        before: { settingsVersionId: prevRow.id, ...prev } as unknown as Prisma.InputJsonValue,
        after: { settingsVersionId: created.id, ...next } as unknown as Prisma.InputJsonValue,
        reason: reason.trim(),
      },
      tx,
    );
    return created;
  });
  return { ok: true as const, row };
}

/**
 * For each setting, who changed it last and when. Walks the version history
 * from newest to oldest and records the first version where the value differs
 * from the one before it.
 */
export async function lastChangedBy(shop: string) {
  const rows = await prisma.settingsVersion.findMany({
    where: { shop },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const keys: (keyof FreightSettings)[] = [
    "targetMargin",
    "flagThreshold",
    "criticalThreshold",
    "maxDiscount",
    "dimDivisor",
    "repriceMaxIncrease",
    "surchargeMax",
    "overrideIsPerBox",
    "tiers",
  ];
  const out: Partial<Record<keyof FreightSettings, { name: string; at: Date; reason: string }>> = {};
  let prev: FreightSettings | null = null;
  for (const r of rows) {
    const cur = rowToSettings(r);
    for (const k of keys) {
      if (!prev || JSON.stringify(prev[k]) !== JSON.stringify(cur[k])) {
        out[k] = { name: r.createdByName, at: r.createdAt, reason: r.reason };
      }
    }
    prev = cur;
  }
  return out;
}
