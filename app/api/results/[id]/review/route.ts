import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import { duplicateReauditMetadataFromNotes } from "@/lib/import-task-metadata";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const { id } = await params;
  const body = (await request.json()) as {
    result?: "PASSED" | "FAILED" | "NEEDS_REVIEW";
    comment?: string;
    productId?: string;
    campaignId?: string;
  };
  if (!body.result) return fail("请选择人工审核结果");
  const manualResult = body.result;
  const auditResult = await prisma.auditResult.findFirst({
    where: { id, supersededAt: null },
    include: { task: true },
  });
  if (!auditResult) return fail("审核结果不存在", 404);
  if (body.productId || body.campaignId) {
    const productId = body.productId || auditResult.task.productId;
    const campaignId = body.campaignId || auditResult.task.campaignId;
    const campaign = await prisma.campaign.findFirst({
      where: {
        id: campaignId,
        OR: [
          { productId },
          { products: { some: { productId } } },
        ],
      },
    });
    if (!campaign) return fail("活动与产品归属不匹配");
    await prisma.auditTask.update({
      where: { id: auditResult.task.id },
      data: { productId, campaignId },
    });
  }
  const duplicateReaudit = duplicateReauditMetadataFromNotes(
    auditResult.task.notes,
  );
  const review = await prisma.$transaction(async (tx) => {
    const created = await tx.manualReview.create({
      data: {
        auditResultId: id,
        reviewerId: user.id,
        result: manualResult,
        comment: body.comment?.trim() || null,
      },
      include: { reviewer: { select: { displayName: true } } },
    });
    await tx.operationLog.create({
      data: {
        userId: user.id,
        action: "MANUAL_REVIEW",
        entityType: "AUDIT_RESULT",
        entityId: id,
        summary: duplicateReaudit
          ? `重复重审最终人工确认：${manualResult}`
          : `人工审核：${manualResult}`,
        metadata: JSON.stringify({
          comment: body.comment || "",
          ...(duplicateReaudit
            ? {
                duplicateReaudit: true,
                automaticResult: duplicateReaudit.automaticResult || null,
                historicalCount: duplicateReaudit.historicalCount,
                sourceTaskIds: duplicateReaudit.sourceTaskIds,
                currentTaskId: auditResult.task.id,
              }
            : {}),
        }),
      },
    });
    return created;
  });
  return ok(review, { status: 201 });
}
