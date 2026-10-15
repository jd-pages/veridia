import type { RuntimeProcess } from "./e2e-server-infrastructure.mjs";
import { captureWindowsScopedResiduals } from "./e2e-server-infrastructure.mjs";

export interface CollectorCallTiming {
  stage: "CALLER_IDENTITY" | "SCOPED_RESIDUALS";
  elapsedMs: number; timeoutMs: number; callerPid: number;
  spawnedPid: number | null; exitCode: number | null; failed: boolean;
}
export function captureCollectorCallerIdentity(execute?: (...args: unknown[]) => unknown): RuntimeProcess;
export function captureCollectorPrimitive(options?: {
  execute?: (...args: unknown[]) => unknown;
  now?: () => number;
  onTiming?: (row: CollectorCallTiming) => void;
  budgetMs?: number;
}): {
  wrapper: RuntimeProcess;
  observed: ReturnType<typeof captureWindowsScopedResiduals>;
  timings: CollectorCallTiming[];
  elapsedMs: number;
};
