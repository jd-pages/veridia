export interface TypegenReceipt {
  execution: "NOT_RUN" | "EXECUTED" | "SKIPPED_NOT_NEEDED";
  executed: boolean;
  status: "PASSED" | "FAILED";
  exitCode: number | null;
  nativeRoot: { pid: number; parentPid: number; nativeStartFileTime: string; createdAt: string; capturedAt: string } | null;
  processQuiescence: { measurement: "AVAILABLE" | "NOT_RUN"; reason?: string; status?: string;
    scope: string; capturedIdentityCount: number | null; remainingCapturedIdentityCount: number | null;
    samplingCount?: number; exhaustiveProcessTreeClaim?: boolean };
  nativeCapturedBeforeCliRelease?: boolean;
  cliReleasedAt?: string;
  failure?: string;
  [key: string]: unknown;
}
export function formalNextEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function skippedNextTypegenReceipt(): TypegenReceipt;
export function runOwnedNodeTypegenCommand(options: { root?: string; entry: string; args?: string[];
  environment?: NodeJS.ProcessEnv; deadlineMs?: number; exitDeadlineMs?: number;
  stdio?: "inherit" | "ignore" | "pipe"; onPhase?: (phase: Record<string, unknown>) => void }): Promise<TypegenReceipt>;
