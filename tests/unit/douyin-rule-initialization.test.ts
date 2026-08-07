import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import builtinRules from "@/rules/default-rules.json";
import { validateRulePayload } from "@/lib/rules/package";
import {
  buildDouyinRuleCopies,
  isExcludedDouyinRequiredTopic,
} from "@/lib/rules/douyin-initialization";

describe("抖音独立业务规则初始化", () => {
  const payload = validateRulePayload(builtinRules);
  const xhsCampaigns = payload.campaigns.filter(
    (campaign) => campaign.contentChannel === "XIAOHONGSHU",
  );
  const douyinCampaigns = payload.campaigns.filter(
    (campaign) => campaign.contentChannel === "DOUYIN",
  );
  const xhsRules = payload.topicRules.filter(
    (rule) => rule.contentChannel === "XIAOHONGSHU",
  );
  const douyinRules = payload.topicRules.filter(
    (rule) => rule.contentChannel === "DOUYIN",
  );

  it("为三个ACTIVE小红书活动生成不同ID的抖音副本", () => {
    expect(xhsCampaigns).toHaveLength(3);
    expect(douyinCampaigns).toHaveLength(3);
    for (const source of xhsCampaigns) {
      const target = douyinCampaigns.find(
        (campaign) => campaign.key === `douyin_${source.key}`,
      );
      expect(target).toMatchObject({
        name: source.name.replace("小红书", "抖音"),
        contentChannel: "DOUYIN",
        productKeys: source.productKeys,
        minImageCount: source.minImageCount,
        productImageRequired: source.productImageRequired,
        firstImageRequirement: source.firstImageRequirement,
        prohibitedImageGuidance: source.prohibitedImageGuidance,
        bodyRequired: source.bodyRequired,
        minBodyLength: source.minBodyLength,
        publicRequired: false,
        retentionDays: source.retentionDays,
        rewardDescription: source.rewardDescription,
        visualReviewGuidance: source.visualReviewGuidance,
        customerRegistrationNotes: source.customerRegistrationNotes,
        clickableTopicRequired: source.clickableTopicRequired,
        ruleRevision: source.ruleRevision,
        status: source.status,
      });
      expect(target?.key).not.toBe(source.key);
      expect(source.publicRequired).toBe(true);
    }
  });

  it("完整复制产品、阶段和段位话题，但精确跳过新手爸妈日记", () => {
    expect(xhsRules).toHaveLength(28);
    expect(douyinRules).toHaveLength(26);
    expect(xhsRules.filter((rule) => isExcludedDouyinRequiredTopic(rule.topic)))
      .toHaveLength(2);
    expect(douyinRules.some((rule) => isExcludedDouyinRequiredTopic(rule.topic)))
      .toBe(false);
    expect(douyinRules.map((rule) => rule.applicableStage).filter(Boolean))
      .toEqual(expect.arrayContaining([
        "IFFO_P1",
        "IFFO_2",
        "GUM_3_4_1PLUS_2PLUS",
      ]));
    expect(douyinRules.every((rule) => rule.key.startsWith("douyin_"))).toBe(true);
    for (const target of douyinRules) {
      const source = xhsRules.find(
        (rule) => `douyin_${rule.key}` === target.key,
      );
      expect(source).toBeTruthy();
      expect(target).toMatchObject({
        brand: source?.brand,
        productKey: source?.productKey,
        scope: source?.scope,
        ruleType: source?.ruleType,
        topicCategory: source?.topicCategory,
        applicableStage: source?.applicableStage,
        milkType: source?.milkType,
        topic: source?.topic,
        exactMatch: source?.exactMatch,
        clickableRequired: source?.clickableRequired,
        caseSensitive: source?.caseSensitive,
        minCount: source?.minCount,
        sortOrder: source?.sortOrder,
        revision: source?.revision,
        status: source?.status,
        notes: source?.notes,
      });
    }
  });

  it("标准化仅移除首尾空格和一个井号，不模糊排除相似话题", () => {
    expect(isExcludedDouyinRequiredTopic(" 爱他美新手爸妈日记 ")).toBe(true);
    expect(isExcludedDouyinRequiredTopic(" #爱他美新手爸妈日记 ")).toBe(true);
    expect(isExcludedDouyinRequiredTopic("#爱他美新手爸妈日记分享")).toBe(false);
  });

  it("重复生成得到相同稳定键，修改副本不会改变小红书源规则", () => {
    const first = buildDouyinRuleCopies(payload);
    const second = buildDouyinRuleCopies(payload);
    expect(second).toEqual(first);
    const sourceTopic = payload.topicRules[1].topic;
    first.topicRules[0].topic = "#管理员修改的抖音话题";
    expect(payload.topicRules[1].topic).toBe(sourceTopic);
  });

  it("数据库迁移只幂等新增抖音副本并精确排除指定话题", () => {
    const sql = fs.readFileSync(
      path.join(
        process.cwd(),
        "prisma/migrations/202608070002_initialize_douyin_business_rules/migration.sql",
      ),
      "utf8",
    );
    expect(sql).toContain("INSERT OR IGNORE INTO \"campaigns\"");
    expect(sql).toContain("INSERT OR IGNORE INTO \"campaign_products\"");
    expect(sql.match(/INSERT OR IGNORE INTO "topic_rules"/gu)).toHaveLength(2);
    expect(sql).toContain("rule.\"contentChannel\" = 'XIAOHONGSHU'");
    expect(sql).toContain("'DOUYIN'");
    expect(sql).toContain("爱他美新手爸妈日记");
    expect(sql).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE|UPDATE)\b/iu);
  });

  it("only disables public-status audit for Douyin campaigns", () => {
    const sql = fs.readFileSync(
      path.join(
        process.cwd(),
        "prisma/migrations/202608070004_douyin_public_not_required/migration.sql",
      ),
      "utf8",
    );
    expect(sql).toContain('WHERE "contentChannel" = \'DOUYIN\'');
    expect(sql).toContain('SET "publicRequired" = false');
    expect(sql).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE)\b/iu);
    expect(sql).not.toMatch(/audit_(?:results|tasks|batches)/iu);
  });
});
