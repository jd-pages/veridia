import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import builtinRules from "@/rules/default-rules.json";
import { validateRulePayload } from "@/lib/rules/package";
import { prepareRulePublishSource } from "@/lib/rules/publish-source";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalRuleDatabasePath = process.env.VERIDIA_RULE_DATABASE_PATH;

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalRuleDatabasePath === undefined) {
    delete process.env.VERIDIA_RULE_DATABASE_PATH;
  } else {
    process.env.VERIDIA_RULE_DATABASE_PATH = originalRuleDatabasePath;
  }
});

describe("规则发布来源", () => {
  it("未指定数据库时使用包含达能和佳贝艾特的项目规则快照", async () => {
    process.env.DATABASE_URL = "file:E:\\v-preview\\data\\veridia.db";
    const source = await prepareRulePublishSource({ ruleDatabasePath: null });

    expect(source.source).toBe("PROJECT_RULE_SOURCE");
    expect(source.sourcePath).toBe(
      path.join(process.cwd(), "rules", "default-rules.json"),
    );

    const payload = await source.createPayload({
      ruleVersion: "rules-2026.08.04.1",
      minimumAppVersion: "1.1.1",
      publishedAt: new Date("2026-08-04T00:00:00.000Z"),
    });
    expect(payload.ruleVersion).toBe("rules-2026.08.04.1");
    expect(payload.minimumAppVersion).toBe("1.1.1");
    expect(new Set(payload.products.map((product) => product.brand))).toEqual(
      new Set(["达能", "佳贝艾特"]),
    );
    expect(payload.campaigns.map((campaign) => campaign.name)).toEqual(
      expect.arrayContaining([
        "爱他美2026年7月小红书种草审核",
        "爱他美2026年8月小红书种草审核",
        "佳贝艾特2026年8月小红书种草审核",
      ]),
    );
    const danoneMonthlyCampaigns = payload.campaigns.filter((campaign) =>
      campaign.name.startsWith("爱他美2026年"),
    );
    expect(danoneMonthlyCampaigns.map((campaign) => campaign.month)).toEqual([
      "2026-07",
      "2026-08",
    ]);
    expect(new Set(danoneMonthlyCampaigns.map((campaign) => campaign.key)).size).toBe(2);
    const augustStageRules = payload.topicRules.filter(
      (rule) =>
        rule.campaignKey === "activity_danone_2026_08" &&
        rule.topicCategory === "PRODUCT_STAGE",
    );
    expect(augustStageRules.map((rule) => [rule.applicableStage, rule.topic])).toEqual([
      ["IFFO_P1", "#新生儿奶粉"],
      ["IFFO_2", "#二段奶粉推荐"],
      ["GUM_3_4_1PLUS_2PLUS", "#三段奶粉推荐"],
    ]);
  });

  it("显式数据库路径优先于项目规则源", async () => {
    const ensureDatabaseReady = vi.fn(async () => ({
      migrated: false,
      structure: {
        hasRequireBodyStage: true,
        requireBodyStageDefaultsToFalse: true,
      },
    }));
    const databasePayload = validateRulePayload(builtinRules);
    const exportDatabasePayload = vi.fn(async () => databasePayload);
    const databasePath = path.resolve("fixtures", "publisher.db");

    const source = await prepareRulePublishSource({
      ruleDatabasePath: databasePath,
      projectRuleSourcePath: path.resolve("missing-project-rules.json"),
      ensureDatabaseReady,
      exportDatabasePayload,
    });
    const payload = await source.createPayload({
      ruleVersion: "rules-2026.08.04.2",
      minimumAppVersion: "1.1.1",
    });

    expect(source.source).toBe("VERIDIA_RULE_DATABASE_PATH");
    expect(source.sourcePath).toBe(databasePath);
    expect(ensureDatabaseReady).toHaveBeenCalledOnce();
    expect(exportDatabasePayload).toHaveBeenCalledWith({
      ruleVersion: "rules-2026.08.04.2",
      minimumAppVersion: "1.1.1",
    });
    expect(payload).toBe(databasePayload);
  });

  it("项目规则源不存在时给出明确处理提示", async () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "veridia-project-rules-"),
    );
    const missingSource = path.join(temporaryRoot, "default-rules.json");

    try {
      await expect(
        prepareRulePublishSource({
          ruleDatabasePath: null,
          projectRuleSourcePath: missingSource,
        }),
      ).rejects.toThrow(
        "未找到项目规则源，请设置 VERIDIA_RULE_DATABASE_PATH 或补充项目规则配置。",
      );
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
