import { describe, expect, it, vi } from "vitest";
import {
  e2eGetWithTransientRetry,
  e2eRequestWithTransientRetry,
} from "../../scripts/testing/e2e-api-request.mjs";

function resetError() {
  return Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
}

describe("E2E own-process requests are never replayed", () => {
  it("a healthy server does not authorize replaying a reset GET", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(resetError())
      .mockResolvedValueOnce({ status: 200 });
    const healthCheck = vi.fn().mockResolvedValue(true);

    await expect(e2eGetWithTransientRetry({ request, healthCheck }))
      .rejects.toMatchObject({ code: "LOCAL_TEST_SERVER_CONNECTION_RESET", serverHealthy: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });

  it("recognizes Playwright's message-only ECONNRESET error", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("apiRequestContext.get: read ECONNRESET"))
      .mockResolvedValueOnce({ status: 200 });
    const healthCheck = vi.fn().mockResolvedValue(true);

    await expect(e2eGetWithTransientRetry({ request, healthCheck }))
      .rejects.toThrow("LOCAL_TEST_SERVER_CONNECTION_RESET");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("preserves the original error as evidence without using a retry budget", async () => {
    const request = vi.fn().mockRejectedValue(resetError());
    const healthCheck = vi.fn().mockResolvedValue(true);

    await expect(e2eGetWithTransientRetry({ request, healthCheck }))
      .rejects.toMatchObject({ cause: { code: "ECONNRESET" } });
    expect(request).toHaveBeenCalledTimes(1);
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });

  it("does not retry an HTTP 404 response", async () => {
    const response = { status: 404 };
    const request = vi.fn().mockResolvedValue(response);
    const healthCheck = vi.fn();

    await expect(e2eGetWithTransientRetry({ request, healthCheck }))
      .resolves.toBe(response);
    expect(request).toHaveBeenCalledTimes(1);
    expect(healthCheck).not.toHaveBeenCalled();
  });

  it("never replays a POST after a connection reset", async () => {
    const request = vi.fn().mockRejectedValue(resetError());
    const healthCheck = vi.fn().mockResolvedValue(true);

    await expect(e2eRequestWithTransientRetry({
      method: "POST",
      request,
      healthCheck,
    })).rejects.toMatchObject({ code: "LOCAL_TEST_SERVER_CONNECTION_RESET", cause: { code: "ECONNRESET" } });
    expect(request).toHaveBeenCalledTimes(1);
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });

  it("fails immediately when the server health endpoint is not ready", async () => {
    const request = vi.fn().mockRejectedValue(resetError());
    const healthCheck = vi.fn().mockResolvedValue(false);

    await expect(e2eGetWithTransientRetry({
      request,
      healthCheck,
      label: "GET /api/example",
    })).rejects.toMatchObject({ code: "LOCAL_TEST_SERVER_CONNECTION_RESET", serverHealthy: false });
    expect(request).toHaveBeenCalledTimes(1);
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });
});
