import { Prisma, type Role, type StaffMember } from "@prisma/client";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { appendAudit, EVENT_TYPES, type Actor } from "./audit.server";

export { ROLE_LABELS } from "./labels";

/**
 * Authenticates an embedded admin request and returns the signed-in staff
 * member. Uses the online token, so `actor` is always a real Shopify user.
 * The first person to open the app on a shop becomes Admin.
 */
export async function requireStaff(request: Request) {
  const ctx = await authenticate.admin(request);
  const { session } = ctx;
  const user = session.onlineAccessInfo?.associated_user;
  if (!user) {
    // Only happens if online tokens are switched off in shopify.server.ts.
    throw new Response("This page needs an online (per-user) session.", { status: 401 });
  }
  const userId = String(user.id);
  const name =
    [user.first_name, user.last_name].filter(Boolean).join(" ").trim() ||
    user.email ||
    `User ${userId}`;

  const staff = await ensureStaff(session.shop, userId, name, user.email ?? null);
  const actor: Actor = { id: userId, name };
  return { ...ctx, shop: session.shop, staff, actor };
}

async function ensureStaff(
  shop: string,
  userId: string,
  name: string,
  email: string | null,
): Promise<StaffMember> {
  const existing = await prisma.staffMember.findUnique({
    where: { shop_userId: { shop, userId } },
  });
  if (existing) {
    if (existing.name !== name || existing.email !== email) {
      return prisma.staffMember.update({
        where: { shop_userId: { shop, userId } },
        data: { name, email },
      });
    }
    return existing;
  }

  // Serializable so two people opening the app at the same moment can't both
  // become the first Admin.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const count = await tx.staffMember.count({ where: { shop } });
          const role: Role = count === 0 ? "ADMIN" : "ANALYST";
          const created = await tx.staffMember.create({
            data: { shop, userId, name, email, role },
          });
          await appendAudit(
            {
              shop,
              actor: { id: userId, name },
              eventType: EVENT_TYPES.staffAdded,
              after: { userId, name, role },
              reason: count === 0 ? "First user to open the app becomes Admin." : null,
            },
            tx,
          );
          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (e) {
      const retryable =
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.code === "P2034" || e.code === "P2002");
      if (!retryable) throw e;
      const now = await prisma.staffMember.findUnique({
        where: { shop_userId: { shop, userId } },
      });
      if (now) return now;
    }
  }
  throw new Error("Could not register staff member.");
}

export function isAdmin(staff: StaffMember) {
  return staff.role === "ADMIN";
}

export async function setRole(shop: string, actor: Actor, userId: string, role: Role, reason: string) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.staffMember.findUniqueOrThrow({
      where: { shop_userId: { shop, userId } },
    });
    if (before.role === "ADMIN" && role !== "ADMIN") {
      const admins = await tx.staffMember.count({ where: { shop, role: "ADMIN" } });
      if (admins <= 1) throw new Error("There must be at least one Admin.");
    }
    const after = await tx.staffMember.update({
      where: { shop_userId: { shop, userId } },
      data: { role },
    });
    await appendAudit(
      {
        shop,
        actor,
        eventType: EVENT_TYPES.roleChanged,
        before: { userId, name: before.name, role: before.role },
        after: { userId, name: after.name, role: after.role },
        reason,
      },
      tx,
    );
    return after;
  });
}
