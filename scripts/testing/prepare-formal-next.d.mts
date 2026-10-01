import type { TypegenReceipt } from "./next-typegen-lifecycle.mjs";
export function formalNextPrepareExitCode(error: { exitCode?: unknown } | null | undefined): number;
export interface FormalNextPrepareReceipt {
  schemaVersion: number;
  purpose: "FORMAL_NEXT_PREPARE_LIFECYCLE";
  invocationId: string;
  receiptPath: string;
  status: "RUNNING" | "PASSED" | "FAILED";
  execution: "NOT_RUN" | "EXECUTED" | "SKIPPED_NOT_NEEDED";
  head?: string;
  sourceFingerprint?: string;
  sourceFingerprintAfter?: string;
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  typegen?: TypegenReceipt;
  [key: string]: unknown;
}
export function prepareFormalNext(options?: { root?: string; environment?: NodeJS.ProcessEnv;
  patcher?: () => Promise<Record<string, unknown>>; cleanup?: (root: string) => string[];
  needsGeneration?: (root: string) => boolean;
  runTypegen?: (options: Parameters<typeof import("./next-typegen-lifecycle.mjs").runOwnedNodeTypegenCommand>[0]) => Promise<TypegenReceipt>;
  fingerprint?: (root: string) => string; head?: (root: string) => string;
  log?: (value: string) => void }): Promise<FormalNextPrepareReceipt>;
