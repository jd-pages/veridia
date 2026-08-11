import { describe, expect, it, vi } from "vitest";
import { waitForStartupRoute } from "../../scripts/testing/e2e-readiness.mjs";

function response(status: number) {
  return {
    status: () => status,
    ok: () => status >= 200 && status < 300,
  };
}

describe("E2E startup route readiness", () => {
  it("只在启动阶段有限重试 404，直到路由明确 ready", async () => {
    let clock = 0;
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(200));

    const result = await waitForStartupRoute({
      label: "login API",
      request,
      timeoutMs: 1_000,
      intervalMs: 100,
      now: () => clock,
      sleep: async (milliseconds: number) => { clock += milliseconds; },
    });

    expect(result.attempts).toBe(3);
    expect(result.elapsedMs).toBe(200);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("不会吞掉认证业务返回的非 404 状态", async () => {
    const request = vi.fn().mockResolvedValue(response(401));

    await expect(waitForStartupRoute({
      label: "login API",
      request,
    })).rejects.toThrow("HTTP 401（非启动期 404，不重试）");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("持续 404 会在有限期限后明确失败", async () => {
    let clock = 0;
    const request = vi.fn().mockResolvedValue(response(404));

    await expect(waitForStartupRoute({
      label: "login API",
      request,
      timeoutMs: 300,
      intervalMs: 100,
      now: () => clock,
      sleep: async (milliseconds: number) => { clock += milliseconds; },
    })).rejects.toThrow("启动就绪超时: HTTP 404，已尝试 4 次");
    expect(request).toHaveBeenCalledTimes(4);
  });
});
