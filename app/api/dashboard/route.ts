import dayjs from "dayjs";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { parseStoredStringArray } from "@/lib/stored-json";
import { currentAuditResultWhere } from "@/lib/audit-result-lifecycle";
import { summarizeDashboardStatusGroups } from "@/lib/dashboard-summary";
import {
  buildDashboardRiskSummaryQuery,
  type DashboardRiskSummaryRow,
} from "@/lib/dashboard-risk-summary";
import { withHeavyAuditReadSlot } from "@/lib/audit-read-concurrency";
import {
  legacyPendingWhere,
} from "@/lib/retention-pending-query";
import { resolveRetentionBusinessClassificationIds } from "@/lib/retention-pending-resolver";

export const GET = withApiErrorBoundary(async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const start = dayjs().startOf("month").toDate();
  const { searchParams } = new URL(request.url);
  const requestedMonth = searchParams.get("month")?.trim();
  const riskMonth = /^\d{4}-\d{2}$/u.test(requestedMonth || "")
    ? dayjs(`${requestedMonth}-01`)
    : dayjs();
  const productId = searchParams.get("productId")?.trim() || undefined;
  const campaignId = searchParams.get("campaignId")?.trim() || undefined;
  const monthScope = { ...currentAuditResultWhere, auditedAt: { gte: start } };
  const statusGroupArgs = Prisma.validator<Prisma.AuditResultGroupByArgs>()({
    by: ["autoStatus", "topicsCompliant", "clickableCompliant"],
    where: monthScope,
    _count: { _all: true },
  });
  const retentionClassification =
    await resolveRetentionBusinessClassificationIds();
  const [
    statusGroups,
    legacyRetentionPendingGroups,
    retentionManualReviewGroups,
    manuallyReviewed,
    resultsWithReasons,
    riskRows,
  ] = await withHeavyAuditReadSlot(() =>
    prisma.$transaction([
      prisma.auditResult.groupBy(statusGroupArgs),
      prisma.auditResult.groupBy({
        by: ["autoStatus"],
        where: {
          AND: [
            monthScope,
            legacyPendingWhere(retentionClassification),
          ],
        },
        _count: { _all: true },
      }),
      prisma.auditResult.groupBy({
        by: ["autoStatus"],
        where: {
          AND: [
            monthScope,
            { id: { in: retentionClassification.retentionManualReviewIds } },
          ],
        },
        _count: { _all: true },
      }),
      prisma.auditResult.count({
        where: { AND: [monthScope, { manualReviews: { some: {} } }] },
      }),
      prisma.auditResult.findMany({
        where: {
          AND: [monthScope, { failureReasons: { not: "[]" } }],
        },
        select: { failureReasons: true },
      }),
      prisma.$queryRaw<DashboardRiskSummaryRow[]>(
        buildDashboardRiskSummaryQuery({
          start: riskMonth.startOf("month").toDate(),
          end: riskMonth.endOf("month").toDate(),
          productId,
          campaignId,
        }),
      ),
    ]),
  );
  const counts = {
    ...summarizeDashboardStatusGroups(
      statusGroups,
      Object.fromEntries(
        legacyRetentionPendingGroups.map((group) => [
          group.autoStatus,
          group._count._all,
        ]),
      ),
      Object.fromEntries(
        retentionManualReviewGroups.map((group) => [
          group.autoStatus,
          group._count._all,
        ]),
      ),
    ),
    manuallyReviewed,
  };
  const reasonMap = new Map<string, number>();
  for (const result of resultsWithReasons) {
    for (const reason of parseStoredStringArray(result.failureReasons)) {
      if (/首图|视觉|产品实拍|合照|罐体|平台导向|图片内容/u.test(reason)) {
        continue;
      }
      reasonMap.set(reason, (reasonMap.get(reason) || 0) + 1);
    }
  }
  const reasonRanking = [...reasonMap.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const riskSummary = riskRows[0];
  return ok({
    ...counts,
    noteUnavailable: Number(riskSummary?.noteUnavailable || 0),
    topicMissing: Number(riskSummary?.topicMissing || 0),
    imageInsufficient: Number(riskSummary?.imageInsufficient || 0),
    passRate: counts.total ? Math.round((counts.passed / counts.total) * 1000) / 10 : 0,
    reasonRanking,
  });
}, "读取仪表盘");
