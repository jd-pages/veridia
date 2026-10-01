import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import {
  installE2ePrismaTransactionDiagnostics,
  readE2ePrismaTransactionDiagnostics,
} from "./testing/prisma-transaction-diagnostics";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

installE2ePrismaTransactionDiagnostics(prisma, process.env.VERIDIA_E2E === "true");

export function getE2ePrismaTransactionDiagnostics() {
  return readE2ePrismaTransactionDiagnostics(prisma, process.env.VERIDIA_E2E === "true");
}
