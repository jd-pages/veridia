import type { AutomationPlatform } from "./platform";

export type AutomaticAuditQueueState = {
  runner?: Promise<void>;
  recovery?: Promise<void>;
  activeBatchId?: string;
  activePlatform?: AutomationPlatform;
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
