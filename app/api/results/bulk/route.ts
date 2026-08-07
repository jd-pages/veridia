import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import { createAutomaticBatch } from "@/lib/automation/batch-service";
import { kickAutomaticAuditQueue } from "@/lib/automation/queue";
import { parseStoredStringArray } from "@/lib/stored-json";
import { resolveReauditCampaignId } from "@/lib/re-audit-campaign";

export async function POST(request: Request) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const body = (await request.json()) as {
    ids?: string[];
    action?: "RE_AUDIT" | "MANUAL_PASS" | "MANUAL_FAIL";
    comment?: string;
  };
  const ids = [...new Set(body.ids || [])].slice(0, 100);
  if (!ids.length || !body.action) return fail("请选择结果和批量操作");
  const results = await prisma.auditResult.findMany({
    where: { id: { in: ids }, supersededAt: null },
    include: { task: true },
  });
  if (results.length !== ids.length) {
    return fail("部分审核结果已被更新，请刷新后重新选择最新结果", 409);
  }
  if (body.action === "RE_AUDIT") {
    try {
      const campaignIds = new Map(
        await Promise.all(
          results.map(async (result) => [
            result.task.id,
            await resolveReauditCampaignId(result.task),
          ] as const),
        ),
      );
      const batch = await createAutomaticBatch({
        name: `重新审核 ${results.length} 条`,
        source: "RE_AUDIT",
        createdBy: user.id,
        tasks: results.map((result) => ({
          importRecordId: result.task.importRecordId,
          url: result.task.url,
          originalInput: result.task.originalInput,
          productId: result.task.productId,
          campaignId: campaignIds.get(result.task.id)!,
          productStage: result.task.productStage,
          milkType: result.task.milkType,
          notes: result.task.notes,
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
          source: "RE_AUDIT",
          replacesResultId: result.id,
          queueOrder: result.resultSlotOrder,
        })),
      });
      await prisma.operationLog.create({
        data: {
          userId: user.id,
          action: "BULK_RE_AUDIT",
          entityType: "AUDIT_RESULT",
          summary: `已将 ${results.length} 条原结果加入重新审核队列`,
          metadata: JSON.stringify({ ids, batchId: batch.id }),
        },
      });
      kickAutomaticAuditQueue();
      return ok({ completed: results.length, errors: [], batchId: batch.id });
    } catch (error) {
      return fail(error instanceof Error ? error.message : "重新审核启动失败", 409);
    }
  }
  let completed = 0;
  const errors: Array<{ id: string; reason: string }> = [];
  for (const result of results) {
    try {
      await prisma.manualReview.create({
        data: {
          auditResultId: result.id,
          reviewerId: user.id,
          result: body.action === "MANUAL_PASS" ? "PASSED" : "FAILED",
          comment: body.comment?.trim() || "批量人工复核",
        },
      });
      completed += 1;
    } catch (error) {
      errors.push({
        id: result.id,
        reason: error instanceof Error ? error.message : "操作失败",
      });
    }
  }
  await prisma.operationLog.create({
    data: {
      userId: user.id,
      action: `BULK_${body.action}`,
      entityType: "AUDIT_RESULT",
      summary: `批量操作完成 ${completed} 条，失败 ${errors.length} 条`,
      metadata: JSON.stringify({ ids }),
    },
  });
  return ok({ completed, errors });
}
