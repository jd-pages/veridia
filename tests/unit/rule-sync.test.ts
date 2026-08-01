import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import builtinRules from "@/rules/default-rules.json";
import { payloadSha256, validateRulePayload } from "@/lib/rules/package";
import defaultTemplates from "@/rules/default-import-export-templates.json";
import {
  isRulePackageCompatible,
  validateRuleManifest,
  verifyRuleManifestSignature,
} from "@/lib/rules/sync";

describe("GitHub 规则同步", () => {
  it("内置规则快照包含产品、活动、阶段组和话题规则", () => {
    const payload = validateRulePayload(builtinRules);
    expect(payload.products.length).toBe(5);
    expect(payload.campaigns.length).toBe(1);
    expect(payload.stageGroups.map((item) => item.key)).toEqual([
      "IFFO_P1",
      "IFFO_2",
      "GUM_3_4_1PLUS_2PLUS",
    ]);
    expect(
      payload.stageGroups.every((item) => item.requireBodyStage === false),
    ).toBe(true);
    expect(payload.topicRules.length).toBe(9);
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
        (item) => item.requireBodyStage === true,
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
      "template-2026.07.30.1",
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
