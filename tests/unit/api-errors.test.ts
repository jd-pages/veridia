import { afterEach, describe, expect, it, vi } from "vitest";
import { withApiErrorBoundary } from "@/lib/api";

afterEach(() => vi.restoreAllMocks());

describe("API 错误边界", () => {
  it("数据库字段缺失时返回中文 503 JSON", async () => {
    const error = Object.assign(new Error("column does not exist"), {
      code: "P2022",
    });
    const handler = withApiErrorBoundary(async () => {
      throw error;
    }, "读取测试数据");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handler();
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      ok: false,
      errorDetail: { code: "DATABASE_SCHEMA_OUTDATED" },
    });
  });

  it("未知异常时返回中文 500 JSON 而不是空响应", async () => {
    const handler = withApiErrorBoundary(async () => {
      throw new Error("internal stack should not reach the browser");
    }, "读取测试数据");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handler();
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      ok: false,
      error: "数据读取失败，请刷新或重启 VERIDIA。",
      errorDetail: { code: "INTERNAL_SERVER_ERROR" },
    });
  });
});
