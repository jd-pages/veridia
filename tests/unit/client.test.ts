import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API 客户端响应解析", () => {
  it("空响应会给出明确错误而不是 JSON 解析异常", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("", {
          status: 500,
        }),
      ),
    );

    await expect(apiFetch("/api/setup/status")).rejects.toThrow(
      "服务返回了空响应（HTTP 500）",
    );
  });

  it("非 JSON 响应会显示状态码和内容类型", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>error</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
      ),
    );

    await expect(apiFetch("/api/setup/status")).rejects.toThrow(
      "服务返回了无法识别的响应（HTTP 502，text/html）",
    );
  });

  it("合法统一响应仍返回 data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          success: true,
          data: { initialized: false },
        }),
      ),
    );

    await expect(
      apiFetch<{ initialized: boolean }>("/api/setup/status"),
    ).resolves.toEqual({ initialized: false });
  });
});
