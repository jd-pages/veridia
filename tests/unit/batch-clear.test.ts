import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canClearAutomaticBatch,
  clearableAutomaticBatchStatuses,
} from "@/lib/automation/task-view";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("清除当前自动审核批次", () => {
  it("只允许终态或停止状态且没有处理中任务的批次清除", () => {
    for (const status of clearableAutomaticBatchStatuses) {
      expect(canClearAutomaticBatch({ status })).toBe(true);
    }
    for (const status of ["QUEUED", "RUNNING", "PROCESSING", "RESUMING", "VERIFYING"]) {
      expect(canClearAutomaticBatch({ status })).toBe(false);
    }
    expect(
      canClearAutomaticBatch({ status: "PAUSED", processingTaskCount: 1 }),
    ).toBe(false);
    expect(
      canClearAutomaticBatch({ status: "PAUSED", currentTaskId: "task-1" }),
    ).toBe(false);
  });

  it("迁移仅增加软删除字段，不删除业务数据", () => {
    const migration = source(
      "prisma/migrations/202608050004_clear_audit_batch_from_task_view/migration.sql",
    );

    expect(migration).toContain('ADD COLUMN "clearedAt"');
    expect(migration).toContain('ADD COLUMN "clearedBy"');
    expect(migration).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE)\b/iu);
  });

  it("服务端事务保留审核结果并记录操作日志", () => {
    const service = source("lib/automation/batch-clear.ts");
    const route = source("app/api/automation/batches/[id]/clear/route.ts");
    const batchRoute = source("app/api/automation/batches/route.ts");
    const taskRoute = source("app/api/tasks/route.ts");
    const taskExport = source("app/api/tasks/export/route.ts");
    const taskVisibility = source("lib/automation/task-view.ts");
    const reconcile = source("lib/automation/batch-runtime-reconcile.ts");

    expect(service).toContain("prisma.$transaction");
    expect(service).toContain("reconcileBatchRuntimeState");
    expect(service).toContain('runtime.classification === "LIVE"');
    expect(reconcile).toContain("STALE_BATCH_RECOVERY");
    expect(service).toContain("retainedAuditResultCount");
    expect(service).toContain("CLEAR_AUTOMATIC_BATCH_FROM_TASK_VIEW");
    expect(service).toContain('failureCode: "BATCH_CLEARED"');
    expect(service).toContain("if (batch.clearedAt)");
    expect(service).toContain("alreadyCleared: true");
    expect(service).toContain("alreadyCleared: false");
    expect(service).not.toContain("auditResult.delete");
    expect(route).toContain("requireApiUser(BUSINESS_ROLES)");
    expect(batchRoute).toContain('"Cache-Control": "no-store"');
    expect(taskRoute).toContain('"Cache-Control": "no-store"');
    expect(taskRoute).toContain("visibleAuditTaskWhere");
    expect(taskExport).toContain("visibleAuditTaskWhere");
    expect(taskVisibility).toContain("batch: { is: { clearedAt: null } }");
  });

  it("页面提供二次确认并清理筛选、分页和旧请求", () => {
    const page = source("app/(admin)/tasks/page.tsx");

    for (const text of [
      "清除当前批次",
      "清除当前批次？",
      "确认清除",
      "清除后，该批次的审核进度、执行记录和任务内容将从审核任务页面移除。此操作不可撤销。",
      "暂无审核任务",
      "创建审核任务后，审核进度和执行记录将在这里显示。",
    ]) {
      expect(page).toContain(text);
    }
    expect(page).toContain("loadSequence.current += 1");
    expect(page).toContain("clearedBatchIds.current.add");
    expect(page).toContain("setBatches([])");
    expect(page).toContain("setTrackedBatchIds([])");
    expect(page).toContain("rememberCurrentBatches([])");
    expect(page).toContain('cache: "no-store"');
    expect(page).toContain('setTaskExecutionFilter("ALL")');
    expect(page).toContain("setTaskPage(1)");
    expect(page).toContain("confirmLoading={Boolean(clearingBatchId)}");
    expect(page).not.toContain("canClearAutomaticBatch({");

    const queue = source("lib/automation/queue.ts");
    expect(queue).toContain('status: { in: ["PENDING", "PROCESSING", "LOGIN_EXPIRED"] }');
    expect(queue).toContain('status: "CANCELLED"');
    expect(queue).toContain('currentTaskId: null');
  });
});
