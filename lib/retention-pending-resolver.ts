import "server-only";
import { prisma } from "@/lib/db";
import { currentAuditResultWhere } from "@/lib/audit-result-lifecycle";
import { withAuditExtractionSnapshot } from "@/lib/audit-extraction-snapshot";
import { buildAuditResultPresentation } from "@/lib/audit-result-presentation";
import type { RetentionBusinessClassificationIds } from "@/lib/retention-pending-query";

/** Resolve retention-era rows from immutable evidence without mutating history. */
export async function resolveRetentionBusinessClassificationIds(): Promise<RetentionBusinessClassificationIds> {
  const rows = await prisma.auditResult.findMany({
    where: {
      AND: [
        currentAuditResultWhere,
        {
          OR: [
            { autoStatus: "PENDING_RETENTION" },
            {
              autoStatus: "NEEDS_REVIEW",
              retentionStatus: { in: ["PENDING", "UNKNOWN"] },
            },
          ],
        },
      ],
    },
    include: {
      note: { select: { id: true } },
      extractionRecord: true,
      ruleResults: {
        select: {
          ruleKey: true,
          ruleName: true,
          expectedValue: true,
          actualValue: true,
          passed: true,
          failureReason: true,
          evidence: true,
        },
        orderBy: { createdAt: "asc" },
      },
      task: {
        select: {
          url: true,
          finalUrl: true,
          channel: true,
          notes: true,
          failureCode: true,
          failureMessage: true,
          pageTitle: true,
          pageType: true,
        },
      },
      manualReviews: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { result: true },
      },
    },
  });
  const normalizedPassIds: string[] = [];
  const normalizedManualReviewIds: string[] = [];
  const normalizedFailedIds: string[] = [];
  for (const row of rows) {
    const presentation = buildAuditResultPresentation(
      withAuditExtractionSnapshot(row),
    );
    const status = presentation.automaticConclusion.status;
    if (status === row.autoStatus) continue;
    if (status === "PASSED") normalizedPassIds.push(row.id);
    if (status === "NEEDS_REVIEW") normalizedManualReviewIds.push(row.id);
    if (status === "FAILED") normalizedFailedIds.push(row.id);
  }
  return {
    normalizedPassIds,
    normalizedManualReviewIds,
    normalizedFailedIds,
  };
}
