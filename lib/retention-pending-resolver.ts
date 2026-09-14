import "server-only";
import { prisma } from "@/lib/db";
import { currentAuditResultWhere } from "@/lib/audit-result-lifecycle";
import { withAuditExtractionSnapshot } from "@/lib/audit-extraction-snapshot";
import { buildAuditResultPresentation } from "@/lib/audit-result-presentation";
import type { RetentionBusinessClassificationIds } from "@/lib/retention-pending-query";

/**
 * Resolve legacy retention rows from immutable evidence in one bounded query.
 * A SQL-only check cannot validate XHS note-id derived publish time, so callers
 * receive exact IDs instead of treating every persisted PENDING value as known.
 */
export async function resolveRetentionBusinessClassificationIds(): Promise<RetentionBusinessClassificationIds> {
  const rows = await prisma.auditResult.findMany({
    where: {
      AND: [
        currentAuditResultWhere,
        {
          OR: [
            { retentionStatus: "PENDING" },
            { autoStatus: "PENDING_RETENTION" },
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
  const pendingIds: string[] = [];
  const retentionManualReviewIds: string[] = [];
  for (const row of rows) {
    const presentation = buildAuditResultPresentation(
      withAuditExtractionSnapshot(row),
    );
    if (presentation.isPendingRetention) pendingIds.push(row.id);
    else if (presentation.isManualReviewRequired) {
      retentionManualReviewIds.push(row.id);
    }
  }
  return { pendingIds, retentionManualReviewIds };
}
