import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { deleteAuditResults } from "@/lib/audit-result-deletion";
import { prisma } from "@/lib/db";
import { normalizeProductStageTopicValue } from "@/lib/product-stage";
import { BUSINESS_ROLES } from "@/lib/permissions";
import { withXhsOriginalPublishedAt } from "@/lib/xhs-original-published-at";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const result = await prisma.auditResult.findUnique({
    where: { id },
    include: {
      note: {
        include: {
          topics: true,
          extractions: { orderBy: { extractedAt: "desc" }, take: 5 },
          noteProducts: { include: { product: true } },
        },
      },
        task: {
          include: { product: true, campaign: true, importRecord: true },
        },
      ruleResults: { orderBy: { createdAt: "asc" } },
      manualReviews: {
        include: { reviewer: { select: { displayName: true, username: true } } },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!result) return fail("审核结果不存在", 404);
  let latestResultId = result.id;
  let nextResultId = result.supersededByResultId;
  const visitedResultIds = new Set([result.id]);
  while (nextResultId && !visitedResultIds.has(nextResultId)) {
    visitedResultIds.add(nextResultId);
    const nextResult = await prisma.auditResult.findUnique({
      where: { id: nextResultId },
      select: { id: true, supersededByResultId: true },
    });
    if (!nextResult) break;
    latestResultId = nextResult.id;
    nextResultId = nextResult.supersededByResultId;
  }
  const normalizedStage = normalizeProductStageTopicValue(
    result.task.productStage,
  );
  const currentStageGroup = normalizedStage
    ? await prisma.ruleStageGroup.findUnique({
        where: { key: normalizedStage },
        select: {
          key: true,
          label: true,
          requiredTopic: true,
          requireBodyStage: true,
          ruleVersion: true,
        },
      })
    : null;
  const operationLogs = await prisma.operationLog.findMany({
    where: {
      OR: [
        { entityId: result.id },
        { entityId: result.task.id },
        { entityId: result.note.id },
      ],
    },
    include: { user: { select: { displayName: true } } },
    orderBy: { createdAt: "desc" },
  });
  return ok(withXhsOriginalPublishedAt({
    ...result,
    isCurrent: result.supersededAt === null,
    latestResultId,
    currentStageGroup,
    operationLogs,
  }));
}

export const DELETE = withApiErrorBoundary(async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!id.trim()) return fail("审核结果 ID 格式不正确", 400);
  return ok(
    await deleteAuditResults({ ids: [id], userId: user.id, mode: "SINGLE" }),
  );
}, "删除审核结果");
