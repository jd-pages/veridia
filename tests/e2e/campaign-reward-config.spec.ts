import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

test("活动奖励配置真实保存、回显、保留产品话题，校验与API失败不关闭弹窗", async ({ page }) => {
  const datasourceUrl = process.env.E2E_DATABASE_URL?.trim();
  if (!datasourceUrl) throw new Error("活动奖励配置验收必须使用隔离 E2E 数据库");
  const db = new PrismaClient({ datasourceUrl });
  const suffix = randomUUID();
  const product = await db.product.create({ data: {
    name: `奖励配置产品-${suffix}`, brandName: "佳贝艾特",
    aliases: { create: [{ alias: `配置别名-${suffix}` }] },
  } });
  const campaign = await db.campaign.create({ data: {
    name: `奖励配置活动-${suffix}`, productId: product.id, month: "2026-10",
    startDate: new Date("2026-10-01T00:00:00Z"), endDate: new Date("2026-10-31T23:59:59Z"),
    products: { create: [{ productId: product.id }] },
  } });
  const topic = `#配置话题${suffix}`;
  await db.topicRule.create({ data: {
    campaignId: campaign.id, brandName: "佳贝艾特", scope: "CAMPAIGN", ruleType: "MUST_ALL", topic,
  } });
  try {
    expect((await page.request.post("/api/auth/login", {
      data: { username: "admin", password: "Admin123!" },
    })).ok()).toBeTruthy();
    await page.goto("/campaigns");
    const row = page.getByRole("row").filter({ hasText: product.name });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "查看规则" }).click();
    const drawer = page.locator(".ant-drawer-content");
    await drawer.getByRole("button", { name: "配置活动奖励" }).click();
    const dialog = page.getByRole("dialog", { name: "配置活动奖励" });
    await dialog.getByLabel("奖励模式", { exact: true }).press("ArrowDown");
    await page.getByText("内容基础奖励 + 阶梯互动额外奖励", { exact: true }).click();
    await dialog.getByLabel("内容通过基础奖励金额", { exact: true }).fill("50");
    await dialog.getByRole("button", { name: "添加互动奖励档位" }).click();
    await dialog.getByLabel("互动量至少", { exact: true }).nth(0).fill("10");
    await dialog.getByLabel("额外奖励金额", { exact: true }).nth(0).fill("20");
    await dialog.getByRole("button", { name: "添加互动奖励档位" }).click();
    await dialog.getByLabel("互动量至少", { exact: true }).nth(1).fill("40");
    await dialog.getByLabel("额外奖励金额", { exact: true }).nth(1).fill("50");
    await dialog.getByLabel("留存天数（仅信息）", { exact: true }).fill("30");
    const saved = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/campaigns/${campaign.id}` && response.request().method() === "PUT");
    await dialog.getByRole("button", { name: "保存配置" }).click();
    expect((await saved).status()).toBe(200);
    await expect(dialog).not.toBeVisible();
    await expect(drawer).toContainText("内容通过基础奖励：50 元");
    await expect(drawer).toContainText("≥10：20元；≥40：50元");
    await expect(drawer).toContainText(`配置别名-${suffix}`);
    await expect(drawer).toContainText(topic);
    const persisted = await db.campaign.findUniqueOrThrow({ where: { id: campaign.id },
      include: { interactionRewardTiers: { orderBy: { threshold: "asc" } } } });
    expect(persisted).toMatchObject({ rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS",
      baseRewardAmount: 50, retentionDays: 30, ruleVersion: campaign.ruleVersion + 1 });
    expect(persisted.interactionRewardTiers.map(({ threshold, amount }) => ({ threshold, amount })))
      .toEqual([{ threshold: 10, amount: 20 }, { threshold: 40, amount: 50 }]);

    await drawer.getByRole("button", { name: "配置活动奖励" }).click();
    await expect(dialog.getByLabel("内容通过基础奖励金额", { exact: true })).toHaveValue("50");
    await expect(dialog.getByLabel("互动量至少", { exact: true }).nth(1)).toHaveValue("40");
    await dialog.getByLabel("互动量至少", { exact: true }).nth(1).fill("10");
    await dialog.getByRole("button", { name: "保存配置" }).click();
    await expect(dialog).toContainText("互动门槛不能重复");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("互动量至少", { exact: true }).nth(1).fill("40");
    const route = `**/api/campaigns/${campaign.id}`;
    await page.route(route, async (request) => {
      if (request.request().method() === "PUT") {
        await request.fulfill({ status: 400, contentType: "application/json",
          body: JSON.stringify({ success: false, error: "隔离验收配置被拒绝" }) });
      } else await request.continue();
    });
    await dialog.getByRole("button", { name: "保存配置" }).click();
    await expect(page.getByText("隔离验收配置被拒绝", { exact: true })).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("内容通过基础奖励金额", { exact: true })).toHaveValue("50");
    await expect(dialog.getByRole("button", { name: "保存配置" })).toBeEnabled();
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).ruleVersion).toBe(persisted.ruleVersion);
    await page.unroute(route);
    await dialog.getByRole("button", { name: /^取\s*消$/ }).click();
  } finally {
    await db.operationLog.deleteMany({ where: { entityId: campaign.id } });
    await db.topicRule.deleteMany({ where: { campaignId: campaign.id } });
    await db.campaign.delete({ where: { id: campaign.id } });
    await db.product.delete({ where: { id: product.id } });
    await db.$disconnect();
  }
});
