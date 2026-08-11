import "server-only";
import { prisma } from "@/lib/db";
import {
  classifyBatchRuntimeState,
  isAutomaticBatchRuntimeLive,
} from "./runtime-state";

export async function reconcileBatchRuntimeState(input: {
  batchId: string;
  userId: string;
}) {
  const snapshot = await prisma.auditBatch.findUnique({
    where: { id: input.batchId },
    select: { id: true, status: true, currentTaskId: true, clearedAt: true },
  });
  if (!snapshot || snapshot.clearedAt) {
    return { classification: "INACTIVE" as const, recoveredTaskCount: 0 };
  }
  const processingTaskCount = await prisma.auditTask.count({
    where: { batchId: input.batchId, status: "PROCESSING" },
  });
  const classification = classifyBatchRuntimeState({
    status: snapshot.status,
    processingTaskCount,
    currentTaskId: snapshot.currentTaskId,
    activeRunner: isAutomaticBatchRuntimeLive(input.batchId),
  });
  if (classification !== "STALE") {
    return { classification, recoveredTaskCount: 0 };
  }

  return prisma.$transaction(async (tx) => {
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
    if (!batch || batch.clearedAt) {
      return { classification: "INACTIVE" as const, recoveredTaskCount: 0 };
    }
    if (isAutomaticBatchRuntimeLive(input.batchId)) {
      return { classification: "LIVE" as const, recoveredTaskCount: 0 };
    }
    const finishedAt = new Date();
    const recovered = await tx.auditTask.updateMany({
      where: {
        batchId: input.batchId,
        status: { in: ["PENDING", "QUEUED", "PROCESSING", "LOGIN_EXPIRED"] },
      },
      data: {
        status: "CANCELLED",
        failureCode: "STALE_BATCH_RECOVERY",
        failureMessage: "检测到批次没有真实执行者，系统已安全收尾",
        finishedAt,
        nextRunAt: null,
      },
    });
    await tx.auditBatch.update({
      where: { id: input.batchId },
      data: {
        status: "CANCELLED",
        currentTaskId: null,
        cancelledAt: finishedAt,
        finishedAt,
        lastErrorCode: "STALE_BATCH_RECOVERY",
        lastErrorMessage: "检测到批次没有真实执行者，系统已安全收尾",
      },
    });
    await tx.operationLog.create({
      data: {
        userId: input.userId,
        action: "STALE_BATCH_RECOVERY",
        entityType: "AUDIT_BATCH",
        entityId: input.batchId,
        summary: `恢复无真实执行者的审核批次：${batch.name || "未命名批次"}`,
        metadata: JSON.stringify({
          previousStatus: batch.status,
          previousCurrentTaskId: batch.currentTaskId,
          recoveredTaskCount: recovered.count,
          diagnosticCode: "STALE_BATCH_RECOVERY",
        }),
      },
    });
    return {
      classification: "STALE" as const,
      recoveredTaskCount: recovered.count,
    };
  });
}
