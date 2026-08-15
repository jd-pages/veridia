import "server-only";
import { Prisma } from "@prisma/client";
import {
  resultImageRiskCodes,
  resultImageRiskPhrases,
  resultTopicMissingCodes,
  resultTopicMissingPhrases,
  resultUnavailablePhrases,
  resultUnavailableStates,
} from "@/lib/result-risk";

export interface DashboardRiskSummaryRow {
  noteUnavailable: bigint | number | null;
  topicMissing: bigint | number | null;
  imageInsufficient: bigint | number | null;
}

function likeAny(columns: Prisma.Sql[], phrases: readonly string[]) {
  return Prisma.join(
    phrases.flatMap((phrase) =>
      columns.map((column) => Prisma.sql`${column} LIKE ${`%${phrase}%`}`),
    ),
    " OR ",
  );
}

export function buildDashboardRiskSummaryQuery(input: {
  start: Date;
  end: Date;
  productId?: string;
  campaignId?: string;
}) {
  const noteUnavailable = Prisma.sql`(
    "result"."pageStatus" IN (${Prisma.join(resultUnavailableStates)})
    OR "task"."failureCode" IN (${Prisma.join(resultUnavailableStates)})
    OR "task"."status" IN (${Prisma.join(resultUnavailableStates)})
    OR ${likeAny([
      Prisma.sql`"result"."failureReasons"`,
      Prisma.sql`"task"."failureMessage"`,
      Prisma.sql`"task"."failureEvidence"`,
      Prisma.sql`"task"."pageTitle"`,
      Prisma.sql`"note"."title"`,
      Prisma.sql`"note"."body"`,
    ], resultUnavailablePhrases)}
  )`;
  const topicMissing = Prisma.sql`(
    "result"."pageStatus" = 'NORMAL' AND (
      "result"."missingTopics" NOT IN ('', '[]')
      OR "task"."failureCode" IN (${Prisma.join(resultTopicMissingCodes)})
      OR ${likeAny(
        [Prisma.sql`"result"."failureReasons"`],
        resultTopicMissingPhrases,
      )}
    )
  )`;
  const imageInsufficient = Prisma.sql`(
    "result"."pageStatus" = 'NORMAL' AND (
      "result"."imageStatus" IN ('NON_COMPLIANT', 'IMAGES_READ_FAILED')
      OR "result"."imageExtractionStatus" = 'IMAGES_READ_FAILED'
      OR "result"."imageCompliant" = FALSE
      OR "task"."failureCode" IN (${Prisma.join(resultImageRiskCodes)})
      OR ${likeAny(
        [Prisma.sql`"result"."failureReasons"`],
        resultImageRiskPhrases,
      )}
    )
  )`;
  return Prisma.sql`
    SELECT
      SUM(CASE WHEN ${noteUnavailable} THEN 1 ELSE 0 END) AS "noteUnavailable",
      SUM(CASE WHEN ${topicMissing} THEN 1 ELSE 0 END) AS "topicMissing",
      SUM(CASE WHEN ${imageInsufficient} THEN 1 ELSE 0 END) AS "imageInsufficient"
    FROM "audit_results" AS "result"
    INNER JOIN "audit_tasks" AS "task"
      ON "task"."id" = "result"."auditTaskId"
    INNER JOIN "note_records" AS "note"
      ON "note"."id" = "result"."noteId"
    WHERE "result"."supersededAt" IS NULL
      AND "result"."auditedAt" >= ${input.start}
      AND "result"."auditedAt" <= ${input.end}
      ${input.productId
        ? Prisma.sql`AND "task"."productId" = ${input.productId}`
        : Prisma.empty}
      ${input.campaignId
        ? Prisma.sql`AND "task"."campaignId" = ${input.campaignId}`
        : Prisma.empty}
  `;
}
