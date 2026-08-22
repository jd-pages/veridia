import type { AutomationPlatform } from "./platform";

export type AutomaticAuditQueueState = {
  runner?: Promise<void>;
  recovery?: Promise<void>;
  activeBatchId?: string;
  activePlatform?: AutomationPlatform;
  restartRequested?: boolean;
};

const globalForQueue = globalThis as typeof globalThis & {
  automaticAuditQueueState?: AutomaticAuditQueueState;
};

export const automaticAuditQueueState =
  globalForQueue.automaticAuditQueueState ??
  (globalForQueue.automaticAuditQueueState = {});

export function isAutomaticBatchRuntimeLive(batchId: string) {
  return Boolean(
    automaticAuditQueueState.runner &&
      automaticAuditQueueState.activeBatchId === batchId,
  );
}

export function isLiveBatchExecutionStateCoherent(input: {
  status: string;
  runEpoch: number;
  currentTaskId: string | null;
  processingTasks: Array<{ id: string; claimEpoch: number | null }>;
}) {
  const claimedTask = input.processingTasks.find(
    (task) =>
      task.id === input.currentTaskId && task.claimEpoch === input.runEpoch,
  );
  if (claimedTask) return true;

  // A registered runner has two legitimate lease-free transition windows:
  // immediately after selecting a QUEUED batch and between RUNNING task claims.
  // CONTINUE is idempotent during either window and must not pause the batch.
  return (
    ["QUEUED", "RUNNING"].includes(input.status) &&
    input.currentTaskId === null &&
    input.processingTasks.length === 0
  );
}

export type BatchRuntimeClassification = "LIVE" | "STALE" | "INACTIVE";

export function classifyBatchRuntimeState(input: {
  status: string;
  processingTaskCount: number;
  currentTaskId: string | null;
  activeRunner: boolean;
}): BatchRuntimeClassification {
  if (input.activeRunner) return "LIVE";
  if (
    ["RUNNING", "RESUMING"].includes(input.status) ||
    input.processingTaskCount > 0 ||
    Boolean(input.currentTaskId)
  ) {
    return "STALE";
  }
  return "INACTIVE";
}
