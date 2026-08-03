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
    const decision = source("components/results/AuditDecisionSummary.tsx");
    const campaignPage = source("app/(admin)/campaigns/page.tsx");
    const rulesPage = source("app/(admin)/rules/page.tsx");
    const visibleSources = [
      taskPage,
      resultPage,
      detailPage,
      detailDrawer,
      decision,
      campaignPage,
      rulesPage,
    ].join("\n");

    expect(taskPage).toContain("PRODUCT_STAGE_TOPIC_OPTIONS.map");
    expect(taskPage).toContain("stageTopicsForProductStage");
    expect(resultPage).toContain("productStageTopicLabel(row.task.productStage)");
    expect(detailPage).toContain("AuditDecisionSummary");
    expect(detailDrawer).toContain("AuditDecisionSummary");
    expect(decision).toContain("productStageTopicLabel(row.task.productStage)");
    expect(decision).toContain('topicSummary.stageCandidates.join(" / ")');
    expect(campaignPage).toContain("productStageTopicLabel(row.applicableStage)");
    expect(rulesPage).toContain("productStageTopicLabel(row.key)");
    expect(rulesPage).toContain("aggregateProductStageTopicRows");
    for (const hidden of [
      "IFFO：P段/1段",
      "IFFO：2段",
      "GUM：3段/4段/1+段/2+段",
    ]) {
      expect(visibleSources).not.toContain(hidden);
    }
  });

  it("规则页和任务规则提示只展示聚合后的阶段话题", () => {
    const taskPage = source("app/(admin)/tasks/page.tsx");
    const rulesPage = source("app/(admin)/rules/page.tsx");

    expect(rulesPage).not.toContain('title: "正文段位校验"');
    expect(rulesPage).not.toContain("不校验，仅匹配话题");
    expect(taskPage).not.toContain("不参与审核，仅用于匹配阶段话题");
    expect(taskPage).not.toContain("requirements.context.rules.find");
    for (const hidden of ["任一命中", "任选其一"]) {
      expect(rulesPage).not.toContain(hidden);
      expect(taskPage).not.toContain(hidden);
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
