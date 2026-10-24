import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

function createClient() {
  let connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    // `next build` imports route modules to collect metadata; nothing connects during that phase.
    if (process.env.NEXT_PHASE !== "phase-production-build") throw new Error("DATABASE_URL is not set");
    connectionString = "postgresql://build-placeholder@localhost:1/none";
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// Reuse one client across hot reloads in development.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export const db = globalForPrisma.prisma ?? createClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
