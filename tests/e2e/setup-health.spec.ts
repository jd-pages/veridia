import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const packageVersion = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
).version as string;

test("健康检查返回合法 JSON", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    version: packageVersion,
    service: "VERIDIA",
  });
});

test("普通浏览器打开首次启动页会显示桌面环境说明", async ({ page }) => {
  await page.route("**/api/setup/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          initialized: false,
          dataDirectory: "本地数据目录",
          desktop: true,
          dataLocationConfirmed: false,
          activatedAccountCount: 0,
          authenticated: false,
          canVerifyActivation: true,
          rules: {
            configured: true,
            currentVersion: "builtin-2026.07.29.1",
            latestVersion: null,
            status: "USING_BUILTIN",
            counts: {
              products: 5,
              activities: 1,
              stageGroups: 3,
              topicRules: 9,
            },
          },
        },
      }),
    });
  });

  await page.goto("/setup");
  await expect(page.getByText("当前页面在普通浏览器中打开")).toBeVisible();
  await expect(page.getByText("首次启动设置")).toBeVisible();
  await expect(page.getByText("首次启动状态读取失败")).toHaveCount(0);
});
