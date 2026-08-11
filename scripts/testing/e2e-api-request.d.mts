export interface E2eRequestRetryOptions<T> {
  method: string;
  request: () => Promise<T>;
  healthCheck: () => Promise<boolean>;
  label?: string;
  maxRetries?: number;
  retryDelaysMs?: number[];
  sleep?: (milliseconds: number) => Promise<unknown>;
  onRetry?: (input: { attempt: number; error: unknown }) => void;
}

export function isTransientE2eNetworkError(error: unknown): boolean;
export function e2eRequestWithTransientRetry<T>(
  options: E2eRequestRetryOptions<T>,
): Promise<T>;
export function e2eGetWithTransientRetry<T>(
  options: Omit<E2eRequestRetryOptions<T>, "method">,
): Promise<T>;
