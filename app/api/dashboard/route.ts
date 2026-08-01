import dayjs from "dayjs";
import { prisma } from "@/lib/db";
import { ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { parseStoredStringArray } from "@/lib/stored-json";

export const GET = withApiErrorBoundary(async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const start = dayjs().startOf("month").toDate();
  const results = await prisma.auditResult.findMany({
    where: { auditedAt: { gte: start } },
    select: {
      autoStatus: true,
      topicsCompliant: true,
      clickableCompliant: true,
      failureReasons: true,
      manualReviews: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
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
    passRate: counts.total ? Math.round((counts.passed / counts.total) * 1000) / 10 : 0,
    reasonRanking,
  });
}, "读取仪表盘");
