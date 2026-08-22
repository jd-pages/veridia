import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import builtinRules from "@/rules/default-rules.json";
import {
  normalizeLocalStageReferences,
  payloadSha256,
  storeTopicRuleStableKey,
  validateRulePayload,
} from "@/lib/rules/package";
import defaultTemplates from "@/rules/default-import-export-templates.json";
import {
  isRulePackageCompatible,
  ruleSyncFailureDetails,
  validateRuleManifest,
  validateRulePackageCounts,
  verifyRuleManifestSignature,
} from "@/lib/rules/sync";

describe("GitHub 规则同步", () => {
  it("旧规则包缺少作用域时默认限定为小红书", () => {
    const legacy = structuredClone(builtinRules) as unknown as {
      campaigns: Array<Record<string, unknown>>;
      topicRules: Array<Record<string, unknown>>;
    };
    legacy.campaigns = legacy.campaigns
      .filter((campaign) => campaign.contentChannel !== "DOUYIN")
      .map((campaign) => {
        const copy = { ...campaign };
        delete copy.contentChannel;
        return copy;
      });
    legacy.topicRules = legacy.topicRules
      .filter((rule) => rule.contentChannel !== "DOUYIN")
      .map((rule) => {
        const copy = { ...rule };
        delete copy.contentChannel;
        return copy;
      });
    const payload = validateRulePayload(legacy);
    expect(
      payload.campaigns.every(
        (campaign) => campaign.contentChannel === "XIAOHONGSHU",
      ),
    ).toBe(true);
    expect(
      payload.topicRules.every(
        (rule) => rule.contentChannel === "XIAOHONGSHU",
      ),
    ).toBe(true);
  });

  it("导出旧本地规则备份时补齐达能阶段话题关联", () => {
    const payload = validateRulePayload(builtinRules);
    const brokenRules = payload.topicRules.map((rule) =>
      rule.topic === "#新生儿奶粉"
        ? { ...rule, applicableStage: "LEGACY_STAGE" }
        : rule,
    );

    const normalized = normalizeLocalStageReferences([], brokenRules);

    expect(
      normalized.topicRules.find((rule) => rule.topic === "#新生儿奶粉")
        ?.applicableStage,
    ).toBe("IFFO_P1");
    expect(
      normalized.topicRules.find((rule) => rule.topic === "#二段奶粉推荐")
        ?.applicableStage,
    ).toBe("IFFO_2");
    expect(
      normalized.topicRules.find((rule) => rule.topic === "#三段奶粉推荐")
        ?.applicableStage,
    ).toBe("GUM_3_4_1PLUS_2PLUS");
    expect(() =>
      validateRulePayload({
        ...payload,
        stageGroups: normalized.stageGroups,
        topicRules: normalized.topicRules,
      }),
    ).not.toThrow();
  });

  it("内置规则快照包含产品、活动、阶段组和话题规则", () => {
    const payload = validateRulePayload(builtinRules);
    expect(payload.products.length).toBe(7);
    expect(payload.campaigns.length).toBe(6);
    expect(
      payload.campaigns.filter(
        (campaign) => campaign.contentChannel === "XIAOHONGSHU",
      ),
    ).toHaveLength(3);
    expect(
      payload.campaigns.filter(
        (campaign) => campaign.contentChannel === "DOUYIN",
      ),
    ).toHaveLength(3);
    expect(payload.stageGroups.map((item) => item.key)).toEqual([
      "IFFO_P1",
      "IFFO_2",
      "GUM_3_4_1PLUS_2PLUS",
    ]);
    expect(
      payload.stageGroups.every((item) => item.requireBodyStage === false),
    ).toBe(true);
    expect(payload.topicRules.length).toBe(54);
    expect(
      payload.topicRules.filter(
        (rule) => rule.contentChannel === "XIAOHONGSHU",
      ),
    ).toHaveLength(28);
    expect(
      payload.topicRules.filter((rule) => rule.contentChannel === "DOUYIN"),
    ).toHaveLength(26);
    expect(payload.products.filter((item) => item.brand === "达能")).toHaveLength(5);
    expect(payload.products.filter((item) => item.brand === "佳贝艾特")).toHaveLength(2);
    expect(payload.topicRules.filter((item) => item.brand === "达能")).toHaveLength(34);
    expect(payload.topicRules.filter((item) => item.brand === "佳贝艾特")).toHaveLength(20);
  });

  it("旧规则包品牌字段可缺省，同名阶段话题可按品牌分别存在", () => {
    const legacy = structuredClone(builtinRules) as unknown as {
      topicRules: Array<Record<string, unknown>>;
    };
    for (const rule of legacy.topicRules) delete rule.brand;
    expect(validateRulePayload(legacy).topicRules).toHaveLength(54);

    const multiBrand = structuredClone(builtinRules);
    multiBrand.products.push({
      ...multiBrand.products[0],
      key: "product_kabrita",
      name: "佳贝艾特示例产品",
      brand: "佳贝艾特",
      series: "佳贝艾特示例产品",
      aliases: ["佳贝艾特示例"],
    });
    multiBrand.campaigns.push({
      ...multiBrand.campaigns[0],
      key: "activity_kabrita",
      name: "佳贝艾特示例活动",
      productKeys: ["product_kabrita"],
    });
    multiBrand.topicRules.push({
      ...multiBrand.topicRules[6],
      key: "topic_kabrita_stage",
      brand: "佳贝艾特",
      campaignKey: "activity_kabrita",
      productKey: null,
    });
    expect(validateRulePayload(multiBrand).topicRules).toHaveLength(55);
  });

  it("旧规则包缺少正文段位开关时保持原校验语义", () => {
    const legacy = structuredClone(builtinRules) as unknown as {
      stageGroups: Array<Record<string, unknown>>;
    };
    for (const group of legacy.stageGroups) {
      delete group.requireBodyStage;
    }
    expect(
      validateRulePayload(legacy).stageGroups.every(
        (item) => item.requireBodyStage === false,
      ),
    ).toBe(true);
  });

  it("规则包模板配置可选，存在时会严格校验", () => {
    const legacy = validateRulePayload(builtinRules);
    expect(legacy.importExportTemplates).toBeUndefined();
    const extended = validateRulePayload({
      ...structuredClone(builtinRules),
      minimumAppVersion: "1.0.2",
      importExportTemplates: defaultTemplates,
    });
    expect(extended.importExportTemplates?.templateVersion).toBe(
      "template-2026.08.07.1",
    );
    const tampered = structuredClone(extended);
    tampered.importExportTemplates!.templateVersion = "template-tampered";
    expect(payloadSha256(tampered)).not.toBe(payloadSha256(extended));
    const invalid = structuredClone(defaultTemplates);
    invalid.fieldAliases.productName.push("链接");
    expect(() =>
      validateRulePayload({
        ...structuredClone(builtinRules),
        importExportTemplates: invalid,
      }),
    ).toThrow(/字段别名冲突/u);
  });

  it("拒绝无效关联和不规范话题", () => {
    const invalid = structuredClone(builtinRules);
    invalid.campaigns[0].productKeys = ["missing-product"];
    expect(() => validateRulePayload(invalid)).toThrow(/不存在的产品/u);

    const invalidTopic = structuredClone(builtinRules);
    invalidTopic.topicRules[0].topic = "没有井号";
    expect(() => validateRulePayload(invalidTopic)).toThrow();
  });

  it("使用 Ed25519 公钥校验清单，篡改后失败", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const bytes = Buffer.from('{"ruleVersion":"rules-2026.07.29.1"}\n');
    const signature = sign(null, bytes, privateKey).toString("base64");
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifyRuleManifestSignature(bytes, signature, publicPem)).toBe(true);
    expect(
      verifyRuleManifestSignature(
        Buffer.from('{"ruleVersion":"rules-2026.07.29.2"}\n'),
        signature,
        publicPem,
      ),
    ).toBe(false);
  });

  it("清单只接受独立规则版本和 GitHub HTTPS 下载地址", () => {
    const manifest = {
      ruleVersion: "rules-2026.07.29.1",
      schemaVersion: 1,
      publishedAt: "2026-07-29T00:00:00.000Z",
      minimumAppVersion: "1.0.0",
      downloadUrl:
        "https://github.com/example/rules/releases/download/rules-2026.07.29.1/veridia-rules.zip",
      fileSize: 100,
      sha256: "a".repeat(64),
      productCount: 5,
      activityCount: 1,
      stageGroupCount: 3,
      topicRuleCount: 9,
    };
    expect(validateRuleManifest(manifest).ruleVersion).toBe(
      "rules-2026.07.29.1",
    );
    expect(() =>
      validateRuleManifest({
        ...manifest,
        ruleVersion: "v1.0.2",
      }),
    ).toThrow(/规则版本/u);
    expect(() =>
      validateRuleManifest({
        ...manifest,
        downloadUrl: "https://example.com/rules.zip",
      }),
    ).toThrow(/GitHub/u);
  });

  it("软件版本低于规则包最低版本时拒绝应用", () => {
    expect(isRulePackageCompatible("1.0.1", "1.0.2")).toBe(false);
    expect(isRulePackageCompatible("1.0.2", "1.0.2")).toBe(true);
    expect(isRulePackageCompatible("1.1.0", "1.0.2")).toBe(true);
    expect(isRulePackageCompatible("1.1.16", "1.1.17")).toBe(false);
    expect(isRulePackageCompatible("1.1.17", "1.1.17")).toBe(true);
  });

  it("旧 Manifest 可缺店铺统计，新规则包必须精确绑定店铺规则和 Alias 数量", () => {
    const payload = validateRulePayload({
      ...structuredClone(builtinRules),
      minimumAppVersion: "1.1.17",
      storeTopicRules: [
        {
          key: storeTopicRuleStableKey("TMALL", "规则同步测试店"),
          commercePlatform: "TMALL",
          storeName: "规则同步测试店",
          enabled: true,
          storeAliases: [
            { value: "规则同步测试别名", enabled: true, sortOrder: 0 },
          ],
          acceptedTopics: [
            { value: "#规则同步测试店", enabled: true, sortOrder: 0 },
          ],
          acceptedAliases: [],
          requiredTopics: [],
        },
      ],
    });
    const manifest = validateRuleManifest({
      ruleVersion: "rules-2026.08.22.1",
      schemaVersion: 1,
      publishedAt: "2026-08-22T00:00:00.000Z",
      minimumAppVersion: "1.1.17",
      downloadUrl:
        "https://github.com/example/rules/releases/download/rules-2026.08.22.1/veridia-rules.zip",
      fileSize: 100,
      sha256: "a".repeat(64),
      productCount: payload.products.length,
      activityCount: payload.campaigns.length,
      stageGroupCount: payload.stageGroups.length,
      topicRuleCount: payload.topicRules.length,
      storeTopicRuleCount: 1,
      storeAliasCount: 1,
    });
    expect(validateRulePackageCounts(payload, manifest)).toMatchObject({
      storeTopicRules: 1,
      storeAliases: 1,
    });
    expect(() =>
      validateRulePackageCounts(payload, {
        ...manifest,
        storeAliasCount: 0,
      }),
    ).toThrow(/数量统计/u);

    const legacy = validateRulePayload(structuredClone(builtinRules));
    expect(() =>
      validateRulePackageCounts(legacy, {
        ...manifest,
        productCount: legacy.products.length,
        activityCount: legacy.campaigns.length,
        stageGroupCount: legacy.stageGroups.length,
        topicRuleCount: legacy.topicRules.length,
        storeTopicRuleCount: undefined,
        storeAliasCount: undefined,
      }),
    ).not.toThrow();
  });

  it("保留普通客户端规则同步的真实错误码和技术原因", () => {
    expect(
      ruleSyncFailureDetails(
        Object.assign(new Error("临时目录拒绝写入"), { code: "EACCES" }),
        "RULE_SYNC_FAILED",
      ),
    ).toEqual({
      errorCode: "EACCES",
      technicalMessage: "临时目录拒绝写入",
    });
    expect(
      ruleSyncFailureDetails(
        new Error("fetch failed", {
          cause: Object.assign(new Error("连接超时"), {
            code: "ETIMEDOUT",
          }),
        }),
        "RULE_SYNC_FAILED",
      ),
    ).toEqual({
      errorCode: "ETIMEDOUT",
      technicalMessage: "fetch failed；连接超时",
    });
    expect(
      ruleSyncFailureDetails("unknown", "RULE_CHECK_FAILED"),
    ).toEqual({
      errorCode: "RULE_CHECK_FAILED",
      technicalMessage: "未知规则同步错误",
    });
  });

  it("客户端同步实现不包含上传方法、遥测或 GitHub Token", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib", "rules", "sync.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/GITHUB_TOKEN|Authorization\s*:/u);
    expect(source).not.toMatch(/method:\s*["'](?:POST|PUT|PATCH|DELETE)/u);
    expect(source).not.toMatch(/telemetry|analytics/iu);
  });

  it("首次启动只包含数据、规则和小红书步骤，不再创建管理员", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "app", "setup", "page.tsx"),
      "utf8",
    );
    expect(source).toContain('{ title: "数据位置" }');
    expect(source).toContain('{ title: "同步规则" }');
    expect(source).toContain('{ title: "登录小红书" }');
    expect(source).not.toMatch(/创建管理员|管理员账号|确认密码/u);
  });
});
