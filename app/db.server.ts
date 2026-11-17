import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}

// One client per function instance. On Vercel, DATABASE_URL is Neon's pooled
// connection string, so many instances can share the database safely.
const prisma = global.prismaGlobal ?? new PrismaClient();
global.prismaGlobal = prisma;

export default prisma;
