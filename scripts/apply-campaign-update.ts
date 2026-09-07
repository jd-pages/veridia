import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { normalizeTopic } from "@/lib/topic";

// Explicit operator action: data file is configuration, never an audit-engine product list.
const [databasePath, updatePath] = process.argv.slice(2);
if (!databasePath || !updatePath || !fs.existsSync(databasePath)) throw new Error("需要现有数据库路径和规则更新 JSON 路径");
const update = JSON.parse(fs.readFileSync(updatePath, "utf8")) as {
  month: string; channels: string[];
  campaign: { minImageCount: number; bodyRequired: boolean; minBodyLength: number; publicRequired: boolean; retentionDays: number; clickableTopicRequired: boolean; interactionRewardEnabled: boolean; interactionRewardThreshold: number; rewardDescription: string };
  products: Array<{ key: string; name: string; brand: string; aliases: string[]; topics: string[] }>;
};
if (!/^\d{4}-\d{2}$/u.test(update.month) || update.channels.some((channel) => !["XIAOHONGSHU", "DOUYIN"].includes(channel))) throw new Error("月份或渠道不合法");
const client = new PrismaClient({ datasourceUrl: `file:${path.resolve(databasePath).replaceAll("\\", "/")}` });
const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
try {
  const report = await client.$transaction(async (tx) => {
    const existing = await tx.product.findMany({ include: { aliases: true } });
    const products = [];
    for (const item of update.products) {
      const names = new Set([item.name, ...item.aliases].map(normalize));
      const matches = existing.filter((product) =>
        normalize(product.brandName) === normalize(item.brand) &&
        [product.name, product.seriesName || "", ...product.aliases.map((alias) => alias.alias)].some((name) => names.has(normalize(name))));
      if (matches.length > 1 || matches[0]?.deletedAt) throw new Error(`产品匹配不唯一或已删除：${item.name}`);
      const product = matches[0] || await tx.product.create({ data: {
        name: item.name, brandName: item.brand, seriesName: item.name, publishedKey: item.key, ruleSource: "LOCAL_DRAFT",
      } });
      for (const alias of item.aliases) await tx.productAlias.upsert({
        where: { productId_alias: { productId: product.id, alias } }, create: { productId: product.id, alias }, update: {},
      });
      products.push({ id: product.id, publishedKey: product.publishedKey, name: product.name, brand: item.brand, reused: matches.length > 0, topics: item.topics });
    }
    const campaigns = [];
    for (const brand of [...new Set(products.map((product) => product.brand))]) {
      for (const contentChannel of update.channels) {
        const linked = products.filter((product) => product.brand === brand);
        const candidates = await tx.campaign.findMany({ where: {
          month: update.month, contentChannel, deletedAt: null,
          OR: [{ product: { brandName: brand } }, { products: { some: { product: { brandName: brand } } } }],
        } });
        if (candidates.length > 1) throw new Error(`月度活动不唯一：${brand}/${contentChannel}`);
        const data = { ...update.campaign, ruleSource: "LOCAL_DRAFT", contentChannel,
          month: update.month, year: Number(update.month.slice(0, 4)),
          name: `${brand}${update.month}${contentChannel === "DOUYIN" ? "抖音" : "小红书"}种草审核`,
          startDate: new Date(`${update.month}-01T00:00:00+08:00`),
          endDate: new Date(Date.UTC(Number(update.month.slice(0, 4)), Number(update.month.slice(5)), 1) - 8 * 3600000 - 1),
        };
        const campaign = candidates[0] ? await tx.campaign.update({ where: { id: candidates[0].id }, data: { ...data, ruleVersion: { increment: 1 } } })
          : await tx.campaign.create({ data: { ...data, publishedKey: `campaign_${brand}_${update.month}_${contentChannel}` } });
        let rules = 0;
        for (const product of linked) {
          await tx.campaignProduct.upsert({ where: { campaignId_productId: { campaignId: campaign.id, productId: product.id } },
            create: { campaignId: campaign.id, productId: product.id }, update: {} });
          for (const [sortOrder, rawTopic] of product.topics.entries()) {
            const topic = normalizeTopic(rawTopic);
            const existingRule = await tx.topicRule.findFirst({ where: { campaignId: campaign.id, productId: product.id, topic } });
            const rule = { campaignId: campaign.id, productId: product.id, brandName: brand, contentChannel,
              scope: "CAMPAIGN", topic, ruleType: "MUST_ALL", topicCategory: "GENERAL", exactMatch: true,
              clickableRequired: true, caseSensitive: true, minCount: 1, sortOrder, status: "ACTIVE", ruleSource: "LOCAL_DRAFT" };
            if (existingRule) await tx.topicRule.update({ where: { id: existingRule.id }, data: rule });
            else await tx.topicRule.create({ data: rule });
            rules++;
          }
        }
        campaigns.push({ id: campaign.id, channel: contentChannel, brand, topicRules: rules });
      }
    }
    return { products, campaigns };
  }, { timeout: 30000 });
  console.log(JSON.stringify(report, null, 2));
} finally { await client.$disconnect(); }
