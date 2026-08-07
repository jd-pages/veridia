import dayjs from "dayjs";
import { prisma } from "@/lib/db";
import { ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { parseStoredStringArray } from "@/lib/stored-json";
import { buildResultRiskWhere } from "@/lib/result-risk";
import { currentAuditResultWhere } from "@/lib/audit-result-lifecycle";

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
  const riskScope = {
    AND: [
      currentAuditResultWhere,
      {
        auditedAt: {
          gte: riskMonth.startOf("month").toDate(),
          lte: riskMonth.endOf("month").toDate(),
        },
      },
      ...(productId || campaignId
        ? [
            {
              task: {
                ...(productId ? { productId } : {}),
                ...(campaignId ? { campaignId } : {}),
              },
            },
          ]
        : []),
    ],
  };
  const [results, noteUnavailable, topicMissing, imageInsufficient] =
    await prisma.$transaction([
      prisma.auditResult.findMany({
        where: { ...currentAuditResultWhere, auditedAt: { gte: start } },
        select: {
          autoStatus: true,
          topicsCompliant: true,
          clickableCompliant: true,
          failureReasons: true,
          manualReviews: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      }),
      prisma.auditResult.count({
        where: {
          AND: [riskScope, buildResultRiskWhere("NOTE_UNAVAILABLE")],
        },
      }),
      prisma.auditResult.count({
        where: {
          AND: [riskScope, buildResultRiskWhere("TOPIC_MISSING")],
        },
      }),
      prisma.auditResult.count({
        where: {
          AND: [riskScope, buildResultRiskWhere("IMAGE_INSUFFICIENT")],
        },
      }),
    ]);
  const counts = {
    total: results.length,
    passed: results.filter((item) => item.autoStatus === "PASSED").length,
    failed: results.filter((item) => item.autoStatus === "FAILED").length,
    needsReview: results.filter((item) => item.autoStatus === "NEEDS_REVIEW").length,
    readFailed: results.filter((item) => item.autoStatus === "READ_FAILED").length,
    topicMissing: results.filter((item) => !item.topicsCompliant).length,
    clickableAbnormal: results.filter((item) => !item.clickableCompliant).length,
    manuallyReviewed: results.filter((item) => item.manualReviews.length > 0).length,
  };
  const reasonMap = new Map<string, number>();
  for (const result of results) {
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
  return ok({
    ...counts,
    noteUnavailable,
    topicMissing,
    imageInsufficient,
    passRate: counts.total ? Math.round((counts.passed / counts.total) * 1000) / 10 : 0,
    reasonRanking,
  });
}, "读取仪表盘");
