import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export async function countAuditResultsByImportRecord(ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const rows = await prisma.$queryRaw<
    Array<{ importRecordId: string; resultCount: bigint | number }>
  >(Prisma.sql`
    SELECT
      "task"."importRecordId" AS "importRecordId",
      COUNT("result"."id") AS "resultCount"
    FROM "audit_tasks" AS "task"
    LEFT JOIN "audit_results" AS "result"
      ON "result"."auditTaskId" = "task"."id"
    WHERE "task"."importRecordId" IN (${Prisma.join(ids)})
    GROUP BY "task"."importRecordId"
  `);
  return new Map(
    rows.map((row) => [row.importRecordId, Number(row.resultCount)]),
  );
}
