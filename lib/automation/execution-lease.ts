import type { Prisma } from "@prisma/client";

export type AutomaticExecutionLease = {
  batchId: string;
  taskId: string;
  runEpoch: number;
  claimEpoch: number;
};

export class StaleRunnerCompletionError extends Error {
  readonly code = "STALE_RUNNER_COMPLETION";

  constructor(public readonly lease: AutomaticExecutionLease) {
    super("旧自动审核执行已失效，拒绝写入业务结果");
    this.name = "StaleRunnerCompletionError";
  }
}

export function isStaleRunnerCompletionError(
  error: unknown,
): error is StaleRunnerCompletionError {
  return error instanceof StaleRunnerCompletionError;
}

export async function lockValidExecutionLease(
  tx: Prisma.TransactionClient,
  lease: AutomaticExecutionLease,
) {
  const batch = await tx.auditBatch.updateMany({
    where: {
      id: lease.batchId,
      status: "RUNNING",
      runEpoch: lease.runEpoch,
      currentTaskId: lease.taskId,
    },
    // A guarded no-op update obtains the database row write lock. Pause either
    // invalidates the epoch first, or waits until this result transaction ends.
    data: { runEpoch: lease.runEpoch },
  });
  const task = await tx.auditTask.updateMany({
    where: {
      id: lease.taskId,
      batchId: lease.batchId,
      status: "PROCESSING",
      claimEpoch: lease.claimEpoch,
    },
    data: { claimEpoch: lease.claimEpoch },
  });
  if (batch.count !== 1 || task.count !== 1) {
    console.warn(
      "[自动审核生命周期] STALE_RUNNER_COMPLETION_REJECTED",
      JSON.stringify({
        batchId: lease.batchId,
        taskId: lease.taskId,
        runEpoch: lease.runEpoch,
        claimEpoch: lease.claimEpoch,
      }),
    );
    throw new StaleRunnerCompletionError(lease);
  }
}

export function taskStatusForPersistedResult(autoStatus: string) {
  if (autoStatus === "READ_FAILED") return "READ_FAILED";
  if (autoStatus === "NEEDS_REVIEW") return "NEEDS_REVIEW";
  return "COMPLETED";
}
