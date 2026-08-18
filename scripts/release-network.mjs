import { classifyReleaseFailure } from "./release-failure.mjs";

export const READ_ONLY_NETWORK_ATTEMPTS = 2;
export const READ_ONLY_NETWORK_BACKOFF_MS = 500;

function retryAllowed(error, attempt, maxAttempts) {
  return attempt < maxAttempts
    && classifyReleaseFailure(error) === "TRANSIENT_NETWORK";
}

export async function retryReadOnlyNetworkOperation(label, operation, options = {}) {
  const attempts = options.attempts || READ_ONLY_NETWORK_ATTEMPTS;
  const backoffMs = options.backoffMs || READ_ONLY_NETWORK_BACKOFF_MS;
  const sleep = options.sleep || ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const value = await operation(attempt);
      options.onAttempt?.({
        label,
        attempt,
        maxAttempts: attempts,
        success: true,
        classification: null,
      });
      return value;
    } catch (error) {
      lastError = error;
      const classification = classifyReleaseFailure(error);
      if (error && typeof error === "object") {
        error.attempt = attempt;
        error.maxAttempts = attempts;
        error.retryCount = attempt - 1;
        error.classification ||= classification;
      }
      options.onAttempt?.({
        label,
        attempt,
        maxAttempts: attempts,
        success: false,
        classification,
        summary: error instanceof Error ? error.message : String(error),
      });
      if (!retryAllowed(error, attempt, attempts)) throw error;
      await sleep(backoffMs * attempt);
    }
  }
  throw lastError || new Error(`${label} failed`);
}

export function retryReadOnlyNetworkOperationSync(label, operation, options = {}) {
  const attempts = options.attempts || READ_ONLY_NETWORK_ATTEMPTS;
  const backoffMs = options.backoffMs || READ_ONLY_NETWORK_BACKOFF_MS;
  const sleep = options.sleep || ((milliseconds) => {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, milliseconds);
  });
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const value = operation(attempt);
      options.onAttempt?.({
        label,
        attempt,
        maxAttempts: attempts,
        success: true,
        classification: null,
      });
      return value;
    } catch (error) {
      lastError = error;
      const classification = classifyReleaseFailure(error);
      if (error && typeof error === "object") {
        error.attempt = attempt;
        error.maxAttempts = attempts;
        error.retryCount = attempt - 1;
        error.classification ||= classification;
      }
      options.onAttempt?.({
        label,
        attempt,
        maxAttempts: attempts,
        success: false,
        classification,
        summary: error instanceof Error ? error.message : String(error),
      });
      if (!retryAllowed(error, attempt, attempts)) throw error;
      sleep(backoffMs * attempt);
    }
  }
  throw lastError || new Error(`${label} failed`);
}
