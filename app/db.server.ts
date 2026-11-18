import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}

// One client per function instance. The client connects with DATABASE_URL_POOLED
// (see prisma/schema.prisma), so many instances can share the database safely.
const prisma = global.prismaGlobal ?? new PrismaClient();
global.prismaGlobal = prisma;

export default prisma;
