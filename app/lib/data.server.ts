import prisma from "../db.server";

export async function latestFinishedScan(shop: string) {
  return prisma.scan.findFirst({
    where: { shop, status: "FINISHED" },
    orderBy: { startedAt: "desc" },
  });
}

export async function latestScan(shop: string) {
  return prisma.scan.findFirst({ where: { shop }, orderBy: { startedAt: "desc" } });
}
