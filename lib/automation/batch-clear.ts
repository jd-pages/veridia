import type { LocalAccountRole } from "@/lib/accounts/types";
import { prisma } from "@/lib/db";
import { clearAutomaticBatchRuntime } from "@/lib/automation/queue";
import {
  canClearAutomaticBatch,
  clearableAutomaticBatchStatuses,
} from "@/lib/automation/task-view";

export class AutomaticBatchClearError extends Error {
  constructor(
    message: string,
    readonly code: "BATCH_NOT_FOUND" | "BATCH_STILL_RUNNING",
    readonly status: number,
  ) {
    super(message);
    this.name = "AutomaticBatchClearError";
  }
}

export async function clearAutomaticBatchFromTaskView(input: {
  batchId: string;
  userId: string;
  role: LocalAccountRole;
}) {
  const clearedAt = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const batch = await tx.auditBatch.findUnique({
      where: { id: input.batchId },
      select: {
        id: true,
        name: true,
        status: true,
        currentTaskId: true,
        clearedAt: true,
      },
    });
    if (!batch) {
      throw new AutomaticBatchClearError(
        "自动审核批次不存在。",
        "BATCH_NOT_FOUND",
        404,
      );
    }

    const [clearedTaskCount, retainedAuditResultCount] = await Promise.all([
      tx.auditTask.count({ where: { batchId: batch.id } }),
      tx.auditResult.count({ where: { task: { batchId: batch.id } } }),
    ]);
    if (batch.clearedAt) {
      const nextBatch = await tx.auditBatch.findFirst({
        where: { id: { not: batch.id }, clearedAt: null },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      return {
        clearedBatchId: batch.id,
        clearedTaskCount,
        retainedAuditResultCount,
        nextBatchId: nextBatch?.id || null,
        clearedAt: batch.clearedAt.toISOString(),
        alreadyCleared: true,
      };
    }

    const processingTaskCount = await tx.auditTask.count({
      where: { batchId: batch.id, status: "PROCESSING" },
    });
    if (!canClearAutomaticBatch({
      status: batch.status,
      processingTaskCount,
      currentTaskId: batch.currentTaskId,
    })) {
      throw new AutomaticBatchClearError(
        "当前批次仍在运行，请先暂停或取消任务后再清除。",
        "BATCH_STILL_RUNNING",
        409,
      );
    }

    await tx.auditTask.updateMany({
      where: {
        batchId: batch.id,
        status: { in: ["PENDING", "QUEUED", "LOGIN_EXPIRED"] },
      },
      data: {
        status: "CANCELLED",
        failureCode: "BATCH_CLEARED",
        failureMessage: "批次已从审核任务页面清除",
        finishedAt: clearedAt,
        nextRunAt: null,
      },
    });

    const cleared = await tx.auditBatch.updateMany({
      where: {
        id: batch.id,
        clearedAt: null,
        status: { in: [...clearableAutomaticBatchStatuses] },
      },
      data: {
        clearedAt,
        clearedBy: input.userId,
        currentTaskId: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    if (!cleared.count) {
      throw new AutomaticBatchClearError(
        "当前批次仍在运行，请先暂停或取消任务后再清除。",
        "BATCH_STILL_RUNNING",
        409,
      );
    }

    const nextBatch = await tx.auditBatch.findFirst({
      where: { id: { not: batch.id }, clearedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    await tx.operationLog.create({
      data: {
        userId: input.userId,
        action: "CLEAR_AUTOMATIC_BATCH_FROM_TASK_VIEW",
        entityType: "AUDIT_BATCH",
        entityId: batch.id,
        summary: `清除审核任务页批次：${batch.name || "未命名批次"}`,
        metadata: JSON.stringify({
          role: input.role,
          batchId: batch.id,
          batchName: batch.name,
          clearedAt: clearedAt.toISOString(),
          previousStatus: batch.status,
          clearedTaskCount,
          retainedAuditResultCount,
          retainedAuditResults: true,
        }),
      },
    });

    return {
      clearedBatchId: batch.id,
      clearedTaskCount,
      retainedAuditResultCount,
      nextBatchId: nextBatch?.id || null,
      clearedAt: clearedAt.toISOString(),
      alreadyCleared: false,
    };
  });

  clearAutomaticBatchRuntime(input.batchId);
  return result;
}
