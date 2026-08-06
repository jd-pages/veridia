import { fail, ok, requireApiUser } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { createAutomaticBatch } from "@/lib/automation/batch-service";
import { kickAutomaticAuditQueue } from "@/lib/automation/queue";
import { parseStoredStringArray } from "@/lib/stored-json";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const { id } = await params;
  const result = await prisma.auditResult.findUnique({
    where: { id },
    include: { note: true, task: true },
  });
  if (!result) return fail("审核结果不存在", 404);
  if (!result.retentionDueAt) return fail("该结果没有待复查的留存日期");
  if (result.retentionDueAt.getTime() > Date.now()) {
    return fail(
      `尚未到留存复查日期：${result.retentionDueAt.toLocaleString("zh-CN")}`,
      409,
    );
  }

  const batch = await createAutomaticBatch({
    name: `留存复查 ${result.note.platformNoteId || result.note.id}`,
    source: "RETENTION_RECHECK",
    createdBy: user.id,
    productId: result.task.productId,
    campaignId: result.task.campaignId,
    productStage: result.task.productStage || undefined,
    tasks: [
      {
        importRecordId: result.task.importRecordId,
        url: result.note.url,
        productId: result.task.productId,
        campaignId: result.task.campaignId,
        productStage: result.task.productStage,
        milkType: result.task.milkType,
        source: "RETENTION_RECHECK",
        platform: result.task.platform,
        channel: result.task.channel,
        commercePlatform: result.task.commercePlatform,
        storeName: result.task.storeName,
        storeTopicRuleId: result.task.storeTopicRuleId,
        matchedStoreName: result.task.matchedStoreName,
        expectedStoreTopic: result.task.expectedStoreTopic,
        expectedStoreTopics: parseStoredStringArray(
          result.task.expectedStoreTopics,
        ),
        requiredStoreTopics: parseStoredStringArray(
          result.task.requiredStoreTopics,
        ),
        storeMappingStatus: result.task.storeMappingStatus,
        orderNumber: result.task.orderNumber,
        notes: `基于历史审核结果 ${result.id} 的公开留存复查`,
      },
    ],
  });
  await prisma.operationLog.create({
    data: {
      userId: user.id,
      action: "CREATE_RETENTION_RECHECK",
      entityType: "AUDIT_RESULT",
      entityId: result.id,
      summary: `创建公开留存复查任务，原历史结果保持不变`,
      metadata: JSON.stringify({ batchId: batch.id }),
    },
  });
  kickAutomaticAuditQueue();
  return ok({ batchId: batch.id });
}
