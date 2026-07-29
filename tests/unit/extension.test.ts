import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("Chrome extension", () => {
  it("使用 Manifest V3 并声明受控主机权限", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(process.cwd(), "extension", "manifest.json"), "utf8"),
    ) as {
      manifest_version: number;
      host_permissions: string[];
      background: { service_worker: string };
      content_scripts: Array<{ matches: string[] }>;
    };
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.host_permissions).toContain("http://localhost:3100/*");
    expect(manifest.host_permissions).toContain("http://127.0.0.1:3100/*");
    expect(manifest.content_scripts[0].matches).toContain(
      "http://localhost:3100/mock/xhs*",
    );
    expect(manifest.background.service_worker).toBe("src/background.js");
  });

  it("默认连接 3100 并支持健康检查和分级错误", () => {
    const source = readFileSync(
      path.join(process.cwd(), "extension", "src", "background.js"),
      "utf8",
    );
    expect(source).toContain('DEFAULT_API_BASE_URL = "http://localhost:3100"');
    expect(source).toContain("/api/extension/health");
    expect(source).toContain("INVALID_TOKEN");
    expect(source).toContain("ENDPOINT_NOT_FOUND");
    expect(source).toContain("CORS_BLOCKED");
    expect(source).toContain("SERVICE_UNAVAILABLE");
    expect(source).not.toContain("console.error(settings");
  });

  it("真实页面选择器集中在独立适配器", () => {
    const source = readFileSync(
      path.join(process.cwd(), "extension", "src", "adapters", "xiaohongshu.js"),
      "utf8",
    );
    expect(source).toContain("const SELECTORS");
    expect(source).toContain("XiaohongshuExtractorAdapter");
  });
});
