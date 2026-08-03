import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("审核任务页面当前批次展示", () => {
  it("任务页只按当前 batchId 请求和渲染任务", () => {
    const taskPage = source("app/(admin)/tasks/page.tsx");

    expect(taskPage).toContain("/api/automation/batches${batchQuery}");
    expect(taskPage).toContain("/api/tasks?batchId=${encodeURIComponent(currentBatch.id)}");
    expect(taskPage).not.toContain('apiFetch<Task[]>("/api/tasks")');
    expect(taskPage.match(/dataSource=\{tasks\}/gu)).toHaveLength(2);
    expect(taskPage).toContain('locale={{ emptyText: "本次任务暂无笔记" }}');
    expect(taskPage).toContain('locale={{ emptyText: "本次任务暂无执行记录" }}');
  });

  it("批次和任务 API 都支持 batchId 服务端过滤", () => {
    const batchRoute = source("app/api/automation/batches/route.ts");
    const batchService = source("lib/automation/batch-service.ts");
    const taskRoute = source("app/api/tasks/route.ts");

    expect(batchRoute).toContain('searchParams.get("batchId")');
    expect(batchService).toContain("where: batchId ? { id: batchId } : undefined");
    expect(taskRoute).toContain('searchParams.get("batchId")');
    expect(taskRoute).toContain("where: { status, batchId }");
  });

  it("页面使用本次任务文案并展示完整摘要", () => {
    const taskPage = source("app/(admin)/tasks/page.tsx");
    const labels = [
      "本次任务内容",
      "查看本次审核任务中的全部笔记及最新执行状态。",
      "批次名称",
      "所属产品",
      "所属活动",
      "产品阶段话题",
      "任务来源",
      "本次笔记数",
      "审核通过",
      "审核不通过",
      "待人工复核",
      "任务状态",
      "创建时间",
      "完成时间",
    ];

    for (const label of labels) expect(taskPage).toContain(label);
    expect(taskPage).not.toContain("最近全部任务");
    expect(taskPage).not.toContain("查看跨批次任务的最新执行状态");
    expect(taskPage).not.toContain("跳次");
  });
});
