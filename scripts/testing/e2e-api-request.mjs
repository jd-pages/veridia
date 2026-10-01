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
}) {
  const normalizedMethod = String(method || "").toUpperCase();
  // Keep the legacy export names for callers, but own-process failures are
  // never replayed. A health probe is diagnostic evidence, not permission to retry.
  try {
    return await request();
  } catch (error) {
    if (!isTransientE2eNetworkError(error)) throw error;
    const healthy = await healthCheck?.().catch(() => false);
    const failure = new Error(
      `LOCAL_TEST_SERVER_CONNECTION_RESET: ${normalizedMethod} ${label}; serverHealthy=${healthy === true}; ${error?.message?.split("\n")[0] || errorCode(error)}`,
      { cause: error },
    );
    failure.code = "LOCAL_TEST_SERVER_CONNECTION_RESET";
    failure.serverHealthy = healthy === true;
    throw failure;
  }
}

export function e2eGetWithTransientRetry(options) {
  return e2eRequestWithTransientRetry({ ...options, method: "GET" });
}
