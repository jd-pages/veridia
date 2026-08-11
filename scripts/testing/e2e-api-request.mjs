const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
]);

function errorCode(error) {
  if (typeof error?.code === "string") return error.code.toUpperCase();
  const causeCode = error?.cause?.code;
  return typeof causeCode === "string" ? causeCode.toUpperCase() : "";
}

export function isTransientE2eNetworkError(error) {
  if (TRANSIENT_NETWORK_CODES.has(errorCode(error))) return true;
  const message = `${error?.message || ""} ${error?.cause?.message || ""}`.toUpperCase();
  return [...TRANSIENT_NETWORK_CODES].some((code) => message.includes(code));
}

export async function e2eRequestWithTransientRetry({
  method,
  request,
  healthCheck,
  label = "E2E API request",
  maxRetries = 2,
  retryDelaysMs = [100, 250],
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  onRetry = () => {},
}) {
  const normalizedMethod = String(method || "").toUpperCase();
  let attempt = 0;

  while (true) {
    try {
      return await request();
    } catch (error) {
      const canRetry = normalizedMethod === "GET"
        && isTransientE2eNetworkError(error)
        && attempt < maxRetries;
      if (!canRetry) throw error;

      const healthy = await healthCheck();
      if (!healthy) {
        throw new Error(`${label} failed while the E2E server was not healthy`, {
          cause: error,
        });
      }

      attempt += 1;
      onRetry({ attempt, error });
      await sleep(retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] ?? 0);
    }
  }
}

export function e2eGetWithTransientRetry(options) {
  return e2eRequestWithTransientRetry({ ...options, method: "GET" });
}
