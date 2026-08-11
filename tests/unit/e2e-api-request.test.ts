import { describe, expect, it, vi } from "vitest";
import {
  e2eGetWithTransientRetry,
  e2eRequestWithTransientRetry,
} from "../../scripts/testing/e2e-api-request.mjs";

function resetError() {
  return Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
}

const noDelay = () => Promise.resolve();

describe("E2E idempotent GET transient retry", () => {
  it("retries a reset GET once after health remains ready", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(resetError())
      .mockResolvedValueOnce({ status: 200 });
    const healthCheck = vi.fn().mockResolvedValue(true);

    await expect(e2eGetWithTransientRetry({ request, healthCheck, sleep: noDelay }))
      .resolves.toEqual({ status: 200 });
    expect(request).toHaveBeenCalledTimes(2);
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });

  it("recognizes Playwright's message-only ECONNRESET error", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("apiRequestContext.get: read ECONNRESET"))
      .mockResolvedValueOnce({ status: 200 });
    const healthCheck = vi.fn().mockResolvedValue(true);

    await expect(e2eGetWithTransientRetry({ request, healthCheck, sleep: noDelay }))
      .resolves.toEqual({ status: 200 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fails after the bounded retry budget is exhausted", async () => {
    const request = vi.fn().mockRejectedValue(resetError());
    const healthCheck = vi.fn().mockResolvedValue(true);

    await expect(e2eGetWithTransientRetry({ request, healthCheck, sleep: noDelay }))
      .rejects.toMatchObject({ code: "ECONNRESET" });
    expect(request).toHaveBeenCalledTimes(3);
    expect(healthCheck).toHaveBeenCalledTimes(2);
  });

  it("does not retry an HTTP 404 response", async () => {
    const response = { status: 404 };
    const request = vi.fn().mockResolvedValue(response);
    const healthCheck = vi.fn();

    await expect(e2eGetWithTransientRetry({ request, healthCheck, sleep: noDelay }))
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
      sleep: noDelay,
    })).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(healthCheck).not.toHaveBeenCalled();
  });

  it("fails immediately when the server health endpoint is not ready", async () => {
    const request = vi.fn().mockRejectedValue(resetError());
    const healthCheck = vi.fn().mockResolvedValue(false);

    await expect(e2eGetWithTransientRetry({
      request,
      healthCheck,
      sleep: noDelay,
      label: "GET /api/example",
    })).rejects.toThrow("E2E server was not healthy");
    expect(request).toHaveBeenCalledTimes(1);
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });
});
