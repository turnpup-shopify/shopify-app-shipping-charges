import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}

/**
 * The first connection from a cold Vercel function to Prisma Postgres can take
 * longer than Prisma's defaults (5s connect, 10s pool wait). Give it 30s, unless
 * the connection string already sets its own values.
 */
export function withConnectionTimeouts(url: string | undefined): string | undefined {
  if (!url) return url;
  const [base, query = ""] = url.split("?", 2);
  const params = new URLSearchParams(query);
  if (!params.has("connect_timeout")) params.set("connect_timeout", "30");
  if (!params.has("pool_timeout")) params.set("pool_timeout", "30");
  return `${base}?${params.toString()}`;
}

// One client per function instance. The client connects with DATABASE_URL_POOLED
// (see prisma/schema.prisma), so many instances can share the database safely.
const datasourceUrl = withConnectionTimeouts(process.env.DATABASE_URL_POOLED);
const prisma =
  global.prismaGlobal ?? new PrismaClient(datasourceUrl ? { datasourceUrl } : undefined);
global.prismaGlobal = prisma;

export default prisma;
