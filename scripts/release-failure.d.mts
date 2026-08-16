export type ReleaseClassification =
  | "DETERMINISTIC"
  | "TRANSIENT_NETWORK"
  | "TEST_TIMEOUT"
  | "FLAKY_CANDIDATE"
  | "ENVIRONMENT";

export interface ReleaseFailureInput {
  stage?: string;
  classification?: ReleaseClassification;
  command?: string;
  summary?: string;
  detailLog?: string;
  target?: string;
  failedItem?: string;
  attempt?: number;
  maxAttempts?: number;
  elapsedMs?: number;
  cacheStatus?: string;
  code?: string;
}

export interface ReleaseFailureResult extends ReleaseFailureInput {
  success: false;
  stage: string;
  classification: ReleaseClassification;
  summary: string;
}

export declare const RELEASE_RESULT_MARKER: string;
export declare const RELEASE_STAGES: readonly string[];
export declare const RELEASE_CLASSIFICATIONS: readonly ReleaseClassification[];
export declare function redactReleaseText(value: unknown): string;
export declare function classifyReleaseFailure(
  value: unknown,
  fallback?: ReleaseClassification,
): ReleaseClassification;
export declare class ReleaseStageError extends Error {
  constructor(input: ReleaseFailureInput, options?: { cause?: unknown });
  stage: string;
  classification: ReleaseClassification;
  command?: string;
  summary: string;
  detailLog?: string;
  target?: string;
  failedItem?: string;
  attempt?: number;
  maxAttempts?: number;
  elapsedMs?: number;
  cacheStatus?: string;
  code: string;
}
export declare function releaseFailureResult(
  error: unknown,
  fallback?: ReleaseFailureInput,
): ReleaseFailureResult;
export declare function releaseResultLine(
  error: unknown,
  fallback?: ReleaseFailureInput,
): string;
export declare function parseReleaseResult(value: unknown): ReleaseFailureResult | null;
export declare function inferVerifyFailure(
  output: unknown,
  detailLog?: string,
): ReleaseStageError;
