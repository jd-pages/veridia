export const SOURCE_SYNC_MODES: Readonly<{
  FETCH_VERIFIED: "FETCH_VERIFIED";
  CACHED_ORIGIN_FALLBACK: "CACHED_ORIGIN_FALLBACK";
}>;

export interface GitCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error & { code?: string };
}

export interface LocalPackageGitState {
  branch: string;
  worktreeStatus: string;
  head: string;
  originMain: string;
  mode: "FETCH_VERIFIED" | "CACHED_ORIGIN_FALLBACK";
  fetchFailure?: string;
}

export class LocalPackageGitStateError extends Error {
  constructor(code: string, message: string, details?: Record<string, unknown>);
  readonly code: string;
  readonly details: Record<string, unknown>;
}

export function runGitCommand(root: string, args: string[], options?: { timeoutMs?: number }): GitCommandResult;
export function classifyGitFetchFailure(result: GitCommandResult): "NETWORK_UNAVAILABLE" | "NON_NETWORK_FAILURE";
export function prepareLocalPackageGitState(options: {
  root: string;
  runGit?: (root: string, args: string[], options?: { timeoutMs?: number }) => GitCommandResult;
  fetchTimeoutMs?: number;
}): LocalPackageGitState;
export function assertLocalPackageGitState(options: {
  state: LocalPackageGitState;
  fullCredential: { commitSha?: string; sourceFingerprint?: string };
  currentSourceFingerprint: string;
}): LocalPackageGitState;
export function assertSoftwarePublishGitState(options: {
  root: string;
  runGit?: (root: string, args: string[], options?: { timeoutMs?: number }) => GitCommandResult;
}): LocalPackageGitState;
export function writeLocalPackageGitState(state: LocalPackageGitState, stream?: { write(value: string): unknown }): void;
