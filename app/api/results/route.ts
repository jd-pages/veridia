import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { backfillMissingProcessingFailureResults } from "@/lib/processing-failure-result";
import {
  buildAuditResultWhere,
  readResultQueryFilters,
} from "@/lib/result-query";
import { summarizeResultStatusGroups } from "@/lib/result-summary";
import { withHeavyAuditReadSlot } from "@/lib/audit-read-concurrency";
import { withXhsOriginalPublishedAt } from "@/lib/xhs-original-published-at";
import { withAuditExtractionSnapshot } from "@/lib/audit-extraction-snapshot";
import { resolveAuditEvidenceFilterIds } from "@/lib/audit-evidence-query";

export const GET = withApiErrorBoundary(async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { searchParams } = new URL(request.url);
  const page = Math.max(Number(searchParams.get("page") || 1), 1);
  const pageSize = Math.min(Math.max(Number(searchParams.get("pageSize") || 20), 1), 100);
  await backfillMissingProcessingFailureResults();
  let where;
  let summaryWhere;
  let filters;
  try {
    filters = readResultQueryFilters(searchParams);
    const evidenceFilters = await resolveAuditEvidenceFilterIds({
      keyword: filters.keyword,
      includeProcessingFailures: filters.status === "PROCESS_FAILED",
    });
    where = buildAuditResultWhere(filters, evidenceFilters);
    const summaryFilters = { ...filters, status: undefined };
    summaryWhere = buildAuditResultWhere(summaryFilters, evidenceFilters);
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "筛选条件不正确",
      400,
    );
  }
  const { total, items, summary } = await withHeavyAuditReadSlot(() =>
    prisma.$transaction(async (tx) => {
    const notFoundTasks = await tx.auditTask.findMany({
      where: {
        failureCode: {
          in: ["NOTE_NOT_FOUND", "PAGE_NOT_FOUND", "NOTE_DELETED"],
        },
      },
      select: { id: true },
    });
    const items = await tx.auditResult.findMany({
        where,
        include: {
          note: { select: { id: true } },
          extractionRecord: true,
          task: {
            include: { product: true, campaign: true, importRecord: true },
          },
          manualReviews: {
            orderBy: { createdAt: "desc" },
            take: 1,
            include: { reviewer: { select: { displayName: true } } },
          },
        },
        orderBy: [
          { resultSlotCreatedAt: "desc" },
          { resultSlotOrder: "asc" },
          { createdAt: "asc" },
          { id: "asc" },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
      });
    const statusGroups = await tx.auditResult.groupBy({
      by: ["autoStatus", "pageStatus"],
      where: summaryWhere,
      _count: { _all: true },
    });
    let additionalNotFound = 0;
    const taskIds = notFoundTasks.map((task) => task.id);
    for (let offset = 0; offset < taskIds.length; offset += 5_000) {
      additionalNotFound += await tx.auditResult.count({
        where: {
          AND: [
            summaryWhere,
            // Bound results keep their own page outcome even while the task retries.
            { extractionRecordId: null },
            { auditTaskId: { in: taskIds.slice(offset, offset + 5_000) } },
            {
              NOT: {
                OR: [
                  { autoStatus: "NOTE_NOT_FOUND" },
                  {
                    pageStatus: {
                      in: ["NOTE_NOT_FOUND", "NOT_FOUND", "DELETED"],
                    },
                  },
                ],
              },
            },
          ],
        },
      });
    }
    const summary = summarizeResultStatusGroups(
      statusGroups,
      additionalNotFound,
    );
    const total = filters.status
      ? await tx.auditResult.count({ where })
      : summary.total;
      return { total, items, summary };
    }),
  );
  const presentationNow = new Date();
  return ok(
    {
      total,
      page,
      pageSize,
      items: items.map((item) => {
        const snapshot = withAuditExtractionSnapshot(item);
        return withXhsOriginalPublishedAt({
          ...snapshot,
          // The list needs business evidence, not the full diagnostic payload.
          extractionRecord: undefined,
          task: { ...snapshot.task, failureEvidence: null },
          note: { ...snapshot.note, extractions: [] },
        }, presentationNow);
      }),
      summary,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}, "读取审核结果");
