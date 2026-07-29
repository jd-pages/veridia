import bcrypt from "bcryptjs";
import type { Campaign, Product } from "@prisma/client";
import { prisma } from "../lib/db";
import { createMockNote, type MockCase } from "../lib/mock-data";
import { normalizeUrl } from "../lib/topic";
import { runAuditTask } from "../lib/audit-service";

async function main() {
  await prisma.manualReview.deleteMany();
  await prisma.ruleResult.deleteMany();
  await prisma.auditResult.deleteMany();
  await prisma.extractionRecord.deleteMany();
  await prisma.noteTopic.deleteMany();
  await prisma.noteProduct.deleteMany();
  await prisma.noteRecord.deleteMany();
  await prisma.auditTask.deleteMany();
  await prisma.auditBatch.deleteMany();
  await prisma.automationSession.deleteMany();
  await prisma.topicRule.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.productAlias.deleteMany();
  await prisma.product.deleteMany();
  await prisma.operationLog.deleteMany();
  await prisma.importRecord.deleteMany();
  await prisma.systemSetting.deleteMany();
  await prisma.user.deleteMany();

  const passwordHash = await bcrypt.hash("Admin123!", 10);
  const [admin, operator, viewer] = await Promise.all([
    prisma.user.create({
      data: {
        username: "admin",
        displayName: "系统管理员",
        passwordHash,
        role: "ADMIN",
      },
    }),
    prisma.user.create({
      data: {
        username: "operator",
        displayName: "运营小安",
        passwordHash,
        role: "OPERATOR",
      },
    }),
    prisma.user.create({
      data: {
        username: "viewer",
        displayName: "只读同事",
        passwordHash,
        role: "VIEWER",
      },
    }),
  ]);

  const productSeeds = [
    ["INNE-ZINC", "inne多维锌", "inne", "儿童营养", ["inne锌"]],
    ["INNE-CMZ", "inne钙镁锌", "inne", "儿童营养", ["inne钙镁锌液体"]],
    ["SWISSE-MULTI-M", "Swisse男士复合维生素", "Swisse", "成人营养", ["Swisse男维"]],
    ["MOVEFREE-CALCIUM", "益节高钙氨糖", "益节", "关节营养", ["益节氨糖"]],
  ] as const;

  const products: Product[] = [];
  for (const [code, name, brandName, category, aliases] of productSeeds) {
    products.push(
      await prisma.product.create({
        data: {
          code,
          name,
          brandName,
          category,
          aliases: { create: aliases.map((alias) => ({ alias })) },
        },
      }),
    );
  }

  const campaignNames = [
    "inne多维锌7月种草",
    "inne钙镁锌7月种草",
    "Swisse男维7月会员日",
    "益节高钙氨糖7月体验活动",
  ];
  const campaigns: Campaign[] = [];
  for (let index = 0; index < products.length; index += 1) {
    campaigns.push(
      await prisma.campaign.create({
        data: {
          productId: products[index].id,
          name: campaignNames[index],
          month: "2026-07",
          startDate: new Date("2026-07-01T00:00:00+08:00"),
          endDate: new Date("2026-07-31T23:59:59+08:00"),
          minImageCount: 2,
          bodyRequired: true,
          clickableTopicRequired: true,
        },
      }),
    );
  }

  const zincRules = [
    ["MUST_ALL", "#inne多维锌", 1, 10],
    ["ANY", "#宝宝营养", 1, 20],
    ["ANY", "#宝宝挑食", 1, 21],
    ["ANY", "#儿童营养", 1, 22],
    ["FORBIDDEN", "#治疗挑食", 1, 30],
    ["FORBIDDEN", "#增高神器", 1, 31],
  ] as const;
  await prisma.topicRule.createMany({
    data: zincRules.map(([ruleType, topic, minCount, sortOrder]) => ({
      campaignId: campaigns[0].id,
      productId: products[0].id,
      scope: "CAMPAIGN",
      ruleType,
      topic,
      exactMatch: true,
      clickableRequired: ruleType !== "FORBIDDEN",
      minCount,
      sortOrder,
      notes: "Seed 示例规则",
    })),
  });

  for (let index = 1; index < campaigns.length; index += 1) {
    await prisma.topicRule.create({
      data: {
        campaignId: campaigns[index].id,
        productId: products[index].id,
        scope: "CAMPAIGN",
        ruleType: "MUST_ALL",
        topic: `#${products[index].name}`,
        clickableRequired: true,
        sortOrder: 10,
      },
    });
  }

  const aptamil = await prisma.product.create({
    data: {
      name: "爱他美澳洲白金版",
      brandName: "爱他美",
      seriesName: "爱他美澳洲白金版",
      category: "婴幼儿奶粉",
      contentDirection: "分享宝宝使用爱他美澳洲白金版后的真实感受",
      aliases: {
        create: [{ alias: "澳白" }, { alias: "澳洲白金" }],
      },
    },
  });
  const aptamilCampaign = await prisma.campaign.create({
    data: {
      name: "爱他美2026年7月小红书种草审核",
      month: "2026-07",
      year: 2026,
      startDate: new Date("2026-07-01T00:00:00+08:00"),
      endDate: new Date("2026-07-31T23:59:59+08:00"),
      minImageCount: 2,
      minBodyLength: 41,
      publicRequired: true,
      retentionDays: 15,
      clickableTopicRequired: true,
      products: {
        create: [{ productId: aptamil.id, sortOrder: 0 }],
      },
    },
  });
  await prisma.topicRule.createMany({
    data: [
      {
        campaignId: aptamilCampaign.id,
        ruleType: "REQUIRED",
        topicCategory: "BRAND_COMMON",
        topic: "#爱他美新手爸妈日记",
        exactMatch: true,
        clickableRequired: true,
        sortOrder: 10,
      },
      {
        campaignId: aptamilCampaign.id,
        productId: aptamil.id,
        ruleType: "REQUIRED",
        topicCategory: "PRODUCT_COMMON",
        topic: "#爱他美澳洲白金版",
        exactMatch: true,
        clickableRequired: true,
        sortOrder: 20,
      },
      {
        campaignId: aptamilCampaign.id,
        productId: aptamil.id,
        ruleType: "REQUIRED",
        topicCategory: "PRODUCT_STAGE",
        applicableStage: "IFFO_P1",
        topic: "#新生儿奶粉",
        exactMatch: true,
        clickableRequired: true,
        sortOrder: 30,
      },
      {
        campaignId: aptamilCampaign.id,
        productId: aptamil.id,
        ruleType: "REQUIRED",
        topicCategory: "PRODUCT_STAGE",
        applicableStage: "IFFO_2",
        topic: "#二段奶粉推荐",
        exactMatch: true,
        clickableRequired: true,
        sortOrder: 31,
      },
      {
        campaignId: aptamilCampaign.id,
        productId: aptamil.id,
        ruleType: "REQUIRED",
        topicCategory: "PRODUCT_STAGE",
        applicableStage: "GUM_3_4_1PLUS_2PLUS",
        topic: "#三段奶粉推荐",
        exactMatch: true,
        clickableRequired: true,
        sortOrder: 32,
      },
    ],
  });

  await prisma.systemSetting.createMany({
    data: [
      {
        key: "AI_ENABLED",
        value: "false",
        description: "AI 语义辅助开关；Key 只从服务端环境变量读取",
      },
      { key: "DEFAULT_MIN_IMAGES", value: "2", description: "默认最低图片数" },
      {
        key: "EXTENSION_TOKEN",
        value: "local-extension-demo-token",
        description: "本地插件提交令牌",
        isSecret: true,
      },
    ],
  });
  await prisma.automationSession.create({
    data: {
      id: "xiaohongshu",
      platform: "XIAOHONGSHU",
      status: "UNKNOWN",
      profilePath: ".playwright/xhs-profile",
    },
  });

  const cases: MockCase[] = [
    "passed",
    "failed",
    "few-images",
    "empty-body",
    "inaccurate-topic",
    "unclickable-topic",
    "read-failed",
  ];
  for (const caseName of cases) {
    const payload = createMockNote(caseName);
    const task = await prisma.auditTask.create({
      data: {
        url: payload.url,
        normalizedUrl: normalizeUrl(payload.url),
        productId: products[0].id,
        campaignId: campaigns[0].id,
        source: "SEED",
        notes: `模拟案例：${caseName}`,
        createdBy: operator.id,
      },
    });
    await runAuditTask(task.id, payload);
  }

  // 为分页、长表格和悬浮横向滚动的端到端测试准备足够多的隔离演示结果。
  // Seed 不进入桌面安装包的用户数据库，正式首次启动也不会执行此段。
  for (let index = 0; index < 15; index += 1) {
    const payload = createMockNote("passed");
    payload.url = `${payload.url}&seed-extra=${index + 1}`;
    payload.finalUrl = payload.url;
    payload.noteId = `mock-passed-extra-${index + 1}`;
    const task = await prisma.auditTask.create({
      data: {
        url: payload.url,
        normalizedUrl: normalizeUrl(payload.url),
        productId: products[0].id,
        campaignId: campaigns[0].id,
        source: "SEED",
        notes: `分页测试案例 ${index + 1}`,
        createdBy: operator.id,
      },
    });
    await runAuditTask(task.id, payload);
  }

  await prisma.operationLog.create({
    data: {
      userId: admin.id,
      action: "SEED_DATABASE",
      entityType: "SYSTEM",
      summary: `初始化演示数据：${products.length} 个产品、${campaigns.length} 个活动、${cases.length} 个审核案例`,
      metadata: JSON.stringify({ viewerId: viewer.id }),
    },
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : "Seed failed");
    await prisma.$disconnect();
    process.exit(1);
  });
