import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";
import packageJson from "@/package.json";

describe("桌面端健康检查", () => {
  it("返回稳定的 200 JSON 响应", async () => {
    const response = GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(payload).toMatchObject({
      ok: true,
      version: packageJson.version,
      service: "VERIDIA",
    });
  });

  it("桌面启动探测不再依赖 setup 业务接口", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "desktop", "main.cjs"),
      "utf8",
    );
    const waitForServerSource = source.slice(
      source.indexOf("function waitForServer"),
      source.indexOf("function sendUpdateStatus"),
    );

    expect(waitForServerSource).toContain('path: HEALTH_PATH');
    expect(waitForServerSource).toContain("JSON.parse(body)");
    expect(waitForServerSource).toContain("payload.instanceId !== serverInstanceId");
    expect(waitForServerSource).not.toContain("/api/setup/status");
  });
});
