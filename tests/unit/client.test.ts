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
      "数据读取失败，请刷新或重启 VERIDIA。",
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
      "数据读取失败，请刷新或重启 VERIDIA。",
    );
  });

  it("权限不足的空响应显示中文权限提示", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 403 })),
    );

    await expect(apiFetch("/api/products", { method: "POST" })).rejects.toThrow(
      "当前账号无此操作权限，请联系管理员。",
    );
  });

  it("统一错误对象会优先显示服务端中文说明", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            ok: false,
            error: {
              code: "PERMISSION_DENIED",
              message: "当前账号无此操作权限，请联系管理员。",
            },
          },
          { status: 403 },
        ),
      ),
    );

    await expect(
      apiFetch("/api/rule-sync/check", { method: "POST" }),
    ).rejects.toThrow("当前账号无此操作权限，请联系管理员。");
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
