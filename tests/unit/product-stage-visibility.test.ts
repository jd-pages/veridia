import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("产品阶段话题用户可见口径", () => {
  it("任务、结果、详情、活动和规则页面统一通过公开阶段组标签展示", () => {
    const taskPage = source("app/(admin)/tasks/page.tsx");
    const resultPage = source("app/(admin)/results/page.tsx");
    const detailPage = source("app/(admin)/results/[id]/page.tsx");
    const detailDrawer = source("components/results/AuditDetailDrawer.tsx");
    const campaignPage = source("app/(admin)/campaigns/page.tsx");
    const rulesPage = source("app/(admin)/rules/page.tsx");
    const visibleSources = [
      taskPage,
      resultPage,
      detailPage,
      detailDrawer,
      campaignPage,
      rulesPage,
    ].join("\n");

    expect(taskPage).toContain("PRODUCT_STAGE_TOPIC_OPTIONS.map");
    expect(resultPage).toContain("productStageTopicLabel(row.task.productStage)");
    expect(detailPage).toContain("productStageTopicLabel(detail.task.productStage)");
    expect(detailDrawer).toContain("productStageTopicLabel(row.task.productStage)");
    expect(campaignPage).toContain("productStageTopicLabel(row.applicableStage)");
    expect(rulesPage).toContain("productStageTopicLabel(row.key)");
    for (const hidden of [
      "IFFO：P段/1段",
      "IFFO：2段",
      "GUM：3段/4段/1+段/2+段",
    ]) {
      expect(visibleSources).not.toContain(hidden);
    }
  });

  it("导入校验使用 IFFO / GUM 严格入口，导出继续使用公开标签", () => {
    const importRoute = source("app/api/import/notes/route.ts");
    const exportSource = source("lib/import-export-templates/export.ts");
    expect(importRoute).toContain("normalizeImportedProductStageTopicValue");
    expect(importRoute).toContain("产品阶段话题请填写 IFFO 或 GUM。");
    expect(exportSource).toContain("productStageTopicLabel(row.task.productStage)");
    expect(exportSource).toContain('formulae: [\'"IFFO,GUM"\']');
  });
});
