import type { ChildProcess } from "node:child_process";
import type { RuntimeSnapshot } from "./e2e-server-infrastructure.mjs";
export class E2eInitialIdentityError extends Error { evidence: Record<string, unknown>; constructor(evidence: Record<string, unknown>); }
export function captureInitialOwnedRoot(child: ChildProcess & { e2eOwnershipFence?: unknown; e2eSpawnReturnedAt?: string }, options: {
  capture: (timeoutMs: number) => RuntimeSnapshot; parentPid: number; name: string; commandIdentity: string; now?: () => number;
}): { runtime: RuntimeSnapshot; evidence: Record<string, unknown> };
export function closeRejectedCreatorChild(child: ChildProcess | undefined, deadlineMs?: number): Promise<Record<string, unknown>>;
