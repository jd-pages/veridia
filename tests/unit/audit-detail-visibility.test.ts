import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("审核详情隐藏项", () => {
  it("不渲染作者、发布时间、15天留存和停用的正文段位提示", () => {
    const detailPage = source("app/(admin)/results/[id]/page.tsx");
    for (const text of [
      'label="作者"',
      'label="发布时间"',
      'label="15天留存"',
      'label="正文段位校验"',
      "不参与审核",
      "产品阶段仅用于匹配对应话题",
    ]) {
      expect(detailPage).not.toContain(text);
    }
  });

  it("保留底层字段、留存复查与产品阶段规则判断", () => {
    const detailPage = source("app/(admin)/results/[id]/page.tsx");
    const auditEngine = source("lib/audit-engine.ts");
    expect(detailPage).toContain("retentionStatus");
    expect(detailPage).toContain("retention/recheck");
    expect(detailPage).toContain("stageTopicFromRuleSnapshot");
    expect(auditEngine).toContain('ruleKey: "PRODUCT_STAGE_BODY"');
    expect(auditEngine).toContain('ruleKey: "GLOBAL_RETENTION"');
  });
});
