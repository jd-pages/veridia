import { prisma } from "@/lib/db";
import { taskStatusForPersistedResult } from "./execution-lease";
import { isLiveBatchExecutionStateCoherent } from "./runtime-state";

const TERMINAL_BATCH_STATUSES = new Set([
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "CANCELLED",
  "CLEARED",
]);

export type ExecutionReconcileReason = "PAUSE" | "RESUME" | "STARTUP";

export async function reconcileBatchExecutionState(input: {
  batchId: string;
  reason: ExecutionReconcileReason;
  liveRunner: boolean;
}) {
  const result = await prisma.$transaction(async (tx) => {
    const batch = await tx.auditBatch.findUnique({
      where: { id: input.batchId },
      include: {
        tasks: {
          where: { status: "PROCESSING" },
          orderBy: [{ queueOrder: "asc" }, { createdAt: "asc" }],
          include: {
            auditResults: {
              where: { supersededAt: null },
              orderBy: { auditedAt: "desc" },
              take: 1,
              select: { id: true, autoStatus: true, auditedAt: true },
            },
          },
        },
      },
    });
    if (!batch || batch.clearedAt) {
      return {
        classification: "INACTIVE" as const,
        batch: null,
        reconciledTaskIds: [] as string[],
        terminalizedTaskIds: [] as string[],
        historicalOrphanCount: 0,
      };
    }
    if (TERMINAL_BATCH_STATUSES.has(batch.status)) {
      return {
        classification: "HISTORICAL_TERMINAL" as const,
        batch,
        reconciledTaskIds: [] as string[],
        terminalizedTaskIds: [] as string[],
        historicalOrphanCount: batch.tasks.length,
      };
    }

    const validLiveTask =
      input.reason === "RESUME" && input.liveRunner
        ? batch.tasks.find(
            (task) =>
              task.id === batch.currentTaskId &&
              task.claimEpoch === batch.runEpoch,
          )
        : undefined;
    const coherentLiveRunner =
      input.reason === "RESUME" &&
      input.liveRunner &&
      isLiveBatchExecutionStateCoherent({
        status: batch.status,
        runEpoch: batch.runEpoch,
        currentTaskId: batch.currentTaskId,
        processingTasks: batch.tasks,
      });
    if (input.reason === "RESUME" && input.liveRunner && !coherentLiveRunner) {
      const paused = await tx.auditBatch.update({
        where: { id: batch.id },
        data: {
          status: "PAUSED",
          runEpoch: { increment: 1 },
          currentTaskId: null,
          pausedAt: new Date(),
          lastErrorCode: "RUNNER_STATE_REVIEW_REQUIRED",
          lastErrorMessage:
            "检测到执行者与当前任务状态不一致，已暂停以防止产生更多处理中任务",
        },
      });
      return {
        classification: "REVIEW_REQUIRED" as const,
        batch: paused,
        reconciledTaskIds: [] as string[],
        terminalizedTaskIds: [] as string[],
        historicalOrphanCount: 0,
      };
    }

    const staleTasks = validLiveTask
      ? batch.tasks.filter((task) => task.id !== validLiveTask.id)
      : batch.tasks;
    const reconciledTaskIds: string[] = [];
    const terminalizedTaskIds: string[] = [];
    for (const task of staleTasks) {
      const persistedResult = task.auditResults[0];
      if (persistedResult) {
        await tx.auditTask.updateMany({
          where: { id: task.id, status: "PROCESSING" },
          data: {
            status: taskStatusForPersistedResult(persistedResult.autoStatus),
            claimEpoch: null,
            failureCode: null,
            failureMessage: null,
            finishedAt: persistedResult.auditedAt,
          },
        });
        terminalizedTaskIds.push(task.id);
      } else {
        await tx.auditTask.updateMany({
          where: { id: task.id, status: "PROCESSING" },
          data: {
            status: "PENDING",
            claimEpoch: null,
            failureCode: null,
            failureMessage: null,
            startedAt: null,
            finishedAt: null,
            nextRunAt: null,
          },
        });
        reconciledTaskIds.push(task.id);
      }
    }

    if (coherentLiveRunner) {
      const liveBatch = await tx.auditBatch.findUniqueOrThrow({
        where: { id: batch.id },
      });
      return {
        classification: "LIVE" as const,
        batch: liveBatch,
        reconciledTaskIds,
        terminalizedTaskIds,
        historicalOrphanCount: 0,
      };
    }

    const recoveryUpdate =
      input.reason === "STARTUP"
        ? {
            status: "PAUSED",
            pausedAt: new Date(),
            lastErrorCode: "INTERRUPTED_RECOVERED",
            lastErrorMessage:
              "检测到上次审核异常中断，任务状态已安全恢复，请点击继续审核。",
          }
        : input.reason === "PAUSE"
          ? { status: "PAUSED", pausedAt: new Date() }
          : {};
    const updatedBatch = await tx.auditBatch.update({
      where: { id: batch.id },
      data: {
        ...recoveryUpdate,
        runEpoch: { increment: 1 },
        currentTaskId: null,
      },
    });
    return {
      classification: "RECONCILED" as const,
      batch: updatedBatch,
      reconciledTaskIds,
      terminalizedTaskIds,
      historicalOrphanCount: 0,
    };
  });

  if (result.reconciledTaskIds.length || result.terminalizedTaskIds.length) {
    console.info(
      "[自动审核生命周期] ORPHAN_PROCESSING_RECONCILED",
      JSON.stringify({
        batchId: input.batchId,
        reason: input.reason,
        requeuedTaskIds: result.reconciledTaskIds,
        terminalizedTaskIds: result.terminalizedTaskIds,
      }),
    );
  }
  return result;
}

export async function recoverInterruptedAutomaticBatches() {
  const candidates = await prisma.auditBatch.findMany({
    where: {
      clearedAt: null,
      status: { notIn: [...TERMINAL_BATCH_STATUSES] },
      OR: [
        { currentTaskId: { not: null } },
        { tasks: { some: { status: "PROCESSING" } } },
        { status: { in: ["RUNNING", "RESUMING"] } },
        { status: "QUEUED", runEpoch: { gt: 0 } },
      ],
    },
    orderBy: [{ queueOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true },
  });
  const recovered: string[] = [];
  for (const candidate of candidates) {
    const result = await reconcileBatchExecutionState({
      batchId: candidate.id,
      reason: "STARTUP",
      liveRunner: false,
    });
    if (result.classification === "RECONCILED") recovered.push(candidate.id);
  }
  if (recovered.length) {
    console.warn(
      "[自动审核生命周期] INTERRUPTED_BATCH_RECOVERED",
      JSON.stringify({ batchIds: recovered }),
    );
  }

  const historicalOrphanCount = await prisma.auditTask.count({
    where: {
      status: "PROCESSING",
      batch: { status: { in: [...TERMINAL_BATCH_STATUSES] } },
    },
  });
  if (historicalOrphanCount) {
    console.warn(
      "[自动审核生命周期] 发现历史遗留处理中任务，不自动改变历史批次",
      JSON.stringify({ historicalOrphanCount }),
    );
  }
  return { recoveredBatchIds: recovered, historicalOrphanCount };
}
