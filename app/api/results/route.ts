import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { backfillMissingProcessingFailureResults } from "@/lib/processing-failure-result";
import {
  buildAuditResultWhere,
  readResultQueryFilters,
} from "@/lib/result-query";

export const GET = withApiErrorBoundary(async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { searchParams } = new URL(request.url);
  const page = Math.max(Number(searchParams.get("page") || 1), 1);
  const pageSize = Math.min(Math.max(Number(searchParams.get("pageSize") || 20), 1), 100);
  await backfillMissingProcessingFailureResults();
  let where;
  try {
    where = buildAuditResultWhere(
      readResultQueryFilters(searchParams),
    );
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "筛选条件不正确",
      400,
    );
  }
  const [total, items] = await prisma.$transaction([
    prisma.auditResult.count({ where }),
    prisma.auditResult.findMany({
      where,
      include: {
        note: { include: { topics: true } },
        task: { include: { product: true, campaign: true } },
        manualReviews: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { reviewer: { select: { displayName: true } } },
        },
      },
      orderBy: { auditedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  return ok({ total, page, pageSize, items });
}, "读取审核结果");
