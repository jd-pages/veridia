import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("活动规则导入安全提示", () => {
  it("不向任何角色渲染页面顶部安全提示", () => {
    const campaignsPage = source("app/(admin)/campaigns/page.tsx");

    expect(campaignsPage).not.toContain("导入安全机制");
    expect(campaignsPage).not.toContain("预检查不会写入数据库");
    expect(campaignsPage).not.toContain("历史审核结果保存的是当时规则快照");
    expect(campaignsPage).not.toContain("当前为只读查看");
  });

  it("保留预检查、确认导入和事务写入保护", () => {
    const campaignsPage = source("app/(admin)/campaigns/page.tsx");
    const importRoute = source("app/api/rule-import/route.ts");
    const importService = source("lib/rule-import.ts");

    for (const label of [
      "下载标准模板",
      "导入活动规则",
      "刷新",
      "查看规则",
      "预检查",
      "确认导入",
    ]) {
      expect(campaignsPage).toContain(label);
    }
    expect(campaignsPage).toContain("submitImport(false)");
    expect(campaignsPage).toContain("submitImport(true)");
    expect(importRoute).toContain("if (!commit) return ok(preview)");
    expect(importRoute).toContain("commitCampaignRuleImport(");
    expect(importService).toContain("prisma.$transaction");
  });
});
