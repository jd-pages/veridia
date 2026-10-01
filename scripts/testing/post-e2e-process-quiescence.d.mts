import type { captureWindowsScopedResiduals, waitForOwnedProcessQuiescence } from "./e2e-server-infrastructure.mjs";

export const E2E_OWNERSHIP_SCOPE: string;
export function validateStoredQuiescenceReceipts(input: Parameters<typeof validatePostE2eReceipts>[0]): ReturnType<typeof validatePostE2eReceipts>;
export function validatePostE2eReceipts(input: {
  root: string; receipts: unknown[]; groups: string[]; head: string; sourceFingerprint: string; startedAt: string; now: string;
}): { status: string; ownershipScope: string; coverage: string; head: string; sourceFingerprint: string;
  groups: string[]; runDirectories: string[]; identities: { pid: number; parentPid: number; name: string; createdAt: string }[]; ports: number[] };
export function enforcePostE2eProcessQuiescence(input: {
  root: string; receipts: unknown[]; groups: string[]; head: string; sourceFingerprint: string; startedAt: string; now: string; deadlineMs?: number;
}, adapters?: { platform?: string; now?: () => number;
  capture?: (port: number, execute?: unknown, timeoutMs?: number) => unknown;
  scoped?: (input: Parameters<typeof captureWindowsScopedResiduals>[0]) => unknown;
  exists?: (path: string) => boolean; wait?: (input: Parameters<typeof waitForOwnedProcessQuiescence>[0]) => Promise<unknown>;
  readIdentity?: () => { head: string; sourceFingerprint: string } }): Promise<Record<string, unknown>>;
