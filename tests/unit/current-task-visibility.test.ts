import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("审核任务页面当前队列展示", () => {
  it("任务页按当前 batchIds 请求汇总和当前页记录", () => {
    const taskPage = source("app/(admin)/tasks/page.tsx");

    expect(taskPage).toContain("/api/automation/batches?${batchQuery}");
    expect(taskPage).toContain("batchQuery.set(\"batchIds\"");
    expect(taskPage).toContain("apiFetch<TaskPage>(`/api/tasks?${query}`)");
    expect(taskPage).toContain("pageSize: String(requestedPageSize)");
    expect(taskPage).toContain("executionStatus: requestedExecutionFilter");
    expect(taskPage).not.toContain('apiFetch<Task[]>("/api/tasks")');
    expect(taskPage.match(/dataSource=\{tasks\}/gu)).toHaveLength(2);
    expect(taskPage).toContain('locale={{ emptyText: "本次任务暂无笔记" }}');
    expect(taskPage).toContain("locale={{ emptyText: taskExecutionEmptyText }}");
  });

  it("批次和任务 API 同时支持 batchId 与 batchIds 服务端过滤", () => {
    const batchRoute = source("app/api/automation/batches/route.ts");
    const batchService = source("lib/automation/batch-service.ts");
    const taskRoute = source("app/api/tasks/route.ts");

    expect(batchRoute).toContain('searchParams.get("batchId")');
    expect(batchRoute).toContain('searchParams.get("batchIds")');
    expect(batchService).toContain("const requestedIds = [batchId, ...batchIds]");
    expect(batchService).toContain("const where = requestedIds.length");
    expect(taskRoute).toContain('searchParams.get("batchId")');
    expect(taskRoute).toContain('searchParams.get("batchIds")');
    expect(taskRoute).toContain("{ batchId: { in: batchIds } }");
    expect(taskRoute).toContain("pageSize");
    expect(taskRoute).toContain('searchParams.get("executionStatus")');
    expect(taskRoute).toContain("buildTaskExecutionFilterWhere");
  });

  it("六张统计卡使用服务端筛选并在切换时重置分页", () => {
    const taskPage = source("app/(admin)/tasks/page.tsx");

    for (const filter of [
      "ALL",
      "WAITING",
      "PROCESSING",
      "SUCCEEDED",
      "FAILED",
      "NEEDS_REVIEW",
    ]) {
      expect(taskPage).toContain(`filter: "${filter}" as const`);
    }
    expect(taskPage).toContain("aria-pressed={taskExecutionFilter === item.filter}");
    expect(taskPage).toContain("onClick={() => applyTaskExecutionFilter(item.filter)}");
    expect(taskPage).toContain("setTaskPage(1)");
    expect(taskPage).toContain("taskExecutionFilterLabels[taskExecutionFilter]");
  });

  it("大批量任务按 50 条分片写入且预检响应最多返回 100 行", () => {
    const batchService = source("lib/automation/batch-service.ts");
    const importRoute = source("app/api/import/notes/route.ts");

    expect(batchService).toContain("AUTOMATIC_TASK_WRITE_CHUNK_SIZE = 50");
    expect(batchService).toContain("tx.auditTask.createMany");
    expect(importRoute).toContain("IMPORT_PREVIEW_ROW_LIMIT = 100");
    expect(importRoute).toContain("rows.slice(0, IMPORT_PREVIEW_ROW_LIMIT)");
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
