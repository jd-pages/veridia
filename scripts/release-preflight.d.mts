export interface ReleasePrerequisite {
  name: string;
  path: string;
  ready: boolean;
  integrity: string;
  sha256?: string;
  cacheAction?: string;
  cacheStatus?: string;
  elapsedMs?: number;
  url?: string;
}

export interface WarmupResult {
  electronVersion: string;
  checksumUrl: string;
  zipName?: string;
  elapsedMs: number;
  checksumElapsedMs?: number;
  networkAttempts?: Array<{
    url: string;
    attempt: number;
    maxAttempts: number;
    elapsedMs: number;
    success: boolean;
    classification?: string;
    summary?: string;
  }>;
  prerequisites: ReleasePrerequisite[];
}

export interface PreflightResult {
  success: true;
  stage: "PREFLIGHT";
  targetVersion: string;
  head: string;
  originHead: string;
  repository: string;
  desktop: Record<string, unknown>;
  system: Record<string, unknown>;
  warmup: WarmupResult;
  timings: Array<{ name: string; milliseconds: number }>;
  elapsedMs: number;
}

export declare function validatePreflightSnapshot<T extends Record<string, unknown>>(
  snapshot: T,
  targetVersion: string,
): T;
export declare function validateWarmupResult<T extends WarmupResult>(result: T): T;
export declare function verifyFileSha256(file: string, expected: string): string;
export declare function fetchTextWithRetry(
  url: string,
  options?: {
    timeoutMs?: number;
    attempts?: number;
    fetchImpl?: (
      url: string,
      options: { signal: AbortSignal; headers?: Record<string, string> },
    ) => Promise<Response>;
    sleep?: (milliseconds: number) => Promise<void>;
    onAttempt?: (result: {
      url: string;
      attempt: number;
      maxAttempts: number;
      elapsedMs: number;
      success: boolean;
      classification?: string;
      summary?: string;
    }) => void;
  },
): Promise<string>;
export declare function createElectronDownloadOptions(
  zipName: string,
  expectedChecksum: string,
): {
  force: false;
  checksums: Record<string, string>;
  downloadOptions: { timeout: { request: number } };
};
export declare function runReleasePreflight(
  input: { root?: string; targetVersion: string },
  dependencyOverrides?: Record<string, unknown>,
): Promise<PreflightResult>;
