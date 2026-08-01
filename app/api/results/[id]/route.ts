import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser } from "@/lib/api";
import { normalizeProductStageTopicValue } from "@/lib/product-stage";

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
      task: { include: { product: true, campaign: true } },
      ruleResults: { orderBy: { createdAt: "asc" } },
      manualReviews: {
        include: { reviewer: { select: { displayName: true, username: true } } },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!result) return fail("审核结果不存在", 404);
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
  return ok({ ...result, currentStageGroup, operationLogs });
}
