export interface NetworkAttempt {
  label: string;
  attempt: number;
  maxAttempts: number;
  success: boolean;
  classification: string | null;
  elapsedMs: number;
  summary?: string;
}

export interface ReadOnlyNetworkRetryOptions {
  attempts?: number;
  backoffMs?: number;
  sleep?: (milliseconds: number) => void | Promise<void>;
  onAttempt?: (result: NetworkAttempt) => void;
}

export declare const READ_ONLY_NETWORK_ATTEMPTS: number;
export declare const READ_ONLY_NETWORK_BACKOFF_MS: number;
export declare function retryReadOnlyNetworkOperation<T>(
  label: string,
  operation: (attempt: number) => Promise<T> | T,
  options?: ReadOnlyNetworkRetryOptions,
): Promise<T>;
export declare function retryReadOnlyNetworkOperationSync<T>(
  label: string,
  operation: (attempt: number) => T,
  options?: ReadOnlyNetworkRetryOptions,
): T;
