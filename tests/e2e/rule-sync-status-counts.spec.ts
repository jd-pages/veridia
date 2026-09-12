import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.E2E_DATABASE_URL?.trim();

test("legacy RuleSyncState 在系统设置显示真实店铺规则与别名数量", async ({ page }) => {
  if (!databaseUrl) {
    throw new Error("本测试只能通过隔离 E2E runner 执行，必须提供 E2E_DATABASE_URL");
  }
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createdIds: string[] = [];
  let hiddenIds: string[] = [];
  let originalCountsJson = "{}";

  try {
    hiddenIds = (await prisma.storeTopicRule.findMany({
      where: { deletedAt: null },
      select: { id: true },
    })).map((rule) => rule.id);
    if (hiddenIds.length > 0) {
      await prisma.storeTopicRule.updateMany({
        where: { id: { in: hiddenIds } },
        data: { deletedAt: new Date() },
      });
    }
    expect(await prisma.storeTopicRule.count({ where: { deletedAt: null } })).toBe(0);
    expect(await prisma.storeTopicEntry.count({
      where: {
        topicType: "STORE_ALIAS",
        deletedAt: null,
        storeTopicRule: { deletedAt: null },
      },
    })).toBe(0);

    const state = await prisma.ruleSyncState.findUniqueOrThrow({
      where: { id: "active" },
    });
    originalCountsJson = state.countsJson;
    const [products, activities, stageGroups, topicRules] = await Promise.all([
      prisma.product.count({ where: { deletedAt: null } }),
      prisma.campaign.count({ where: { deletedAt: null } }),
      prisma.ruleStageGroup.count(),
      prisma.topicRule.count(),
    ]);
    const current = { products, activities, stageGroups, topicRules };

    for (let index = 0; index < 3; index += 1) {
      const storeName = `状态统计店铺-${suffix}-${index + 1}`;
      const created = await prisma.storeTopicRule.create({
        data: {
          commercePlatform: "JD",
          storeName,
          normalizedStoreName: storeName.toLowerCase(),
          expectedTopic: `#状态统计话题${index + 1}`,
          enabled: true,
          topicEntries: {
            create: [
              {
                topic: `#状态统计话题${index + 1}`,
                normalizedTopic: `#状态统计话题${index + 1}`,
                topicType: "ACCEPTED",
                enabled: true,
                sortOrder: 0,
              },
              ...(index < 2
                ? [{
                    topic: `状态统计别名-${suffix}-${index + 1}`,
                    normalizedTopic: `状态统计别名-${suffix}-${index + 1}`,
                    topicType: "STORE_ALIAS",
                    enabled: true,
                    sortOrder: 0,
                  }]
                : []),
            ],
          },
        },
      });
      createdIds.push(created.id);
    }

    await prisma.ruleSyncState.update({
      where: { id: "active" },
      data: {
        countsJson: JSON.stringify({
          products: current.products,
          activities: current.activities,
          stageGroups: current.stageGroups,
          topicRules: current.topicRules,
        }),
      },
    });

    const login = await page.request.post("/api/auth/login", {
      data: { username: "admin", password: "Admin123!" },
    });
    expect(login.ok()).toBeTruthy();

    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "系统设置" })).toBeVisible();
    await expect(page.getByText(
      `产品 ${current.products} · 活动 ${current.activities} · 阶段组 ${current.stageGroups} · 话题 ${current.topicRules} · 店铺规则 3 · 导入别名 2`,
      { exact: true },
    )).toBeVisible();

    const statusResponse = await page.request.get("/api/rule-sync/status");
    expect(statusResponse.ok()).toBeTruthy();
    expect((await statusResponse.json()).data.counts).toEqual({
      products: current.products,
      activities: current.activities,
      stageGroups: current.stageGroups,
      topicRules: current.topicRules,
      storeTopicRules: 3,
      storeAliases: 2,
    });

    await expect(page.getByText("自动检查更新", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "检查更新", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "立即同步", exact: true })).toBeVisible();
  } finally {
    if (createdIds.length > 0) {
      await prisma.storeTopicRule.deleteMany({ where: { id: { in: createdIds } } });
    }
    if (hiddenIds.length > 0) {
      await prisma.storeTopicRule.updateMany({
        where: { id: { in: hiddenIds } },
        data: { deletedAt: null },
      }).catch(() => undefined);
    }
    await prisma.ruleSyncState.update({
      where: { id: "active" },
      data: { countsJson: originalCountsJson },
    }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
