import type { APIRequestContext, APIResponse } from "@playwright/test";
import { e2eGetWithTransientRetry } from "../../../scripts/testing/e2e-api-request.mjs";

async function healthEndpointIsReady(request: APIRequestContext) {
  try {
    const response = await request.get("/api/health", { timeout: 3_000, maxRetries: 0 });
    if (response.status() !== 200) return false;
    const body = await response.json().catch(() => null);
    return body?.ok === true;
  } catch {
    return false;
  }
}

export function getWithTransientNetworkRetry(
  request: APIRequestContext,
  url: string,
): Promise<APIResponse> {
  return e2eGetWithTransientRetry({
    label: `GET ${url}`,
    request: () => request.get(url, { maxRetries: 0 }),
    healthCheck: () => healthEndpointIsReady(request),
  });
}
