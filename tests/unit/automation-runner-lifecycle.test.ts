import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AutomaticExtractionHandoffCancelledError,
  runWithExtractionDeadline,
} from "@/lib/automation/extraction-deadline";
import {
  taskStatusForPersistedResult,
} from "@/lib/automation/execution-lease";
import {
  claimRunnerWake,
  completeRunnerWake,
  requestRunnerWake,
} from "@/lib/automation/runner-handoff";

const root = process.cwd();

describe("Pause / Resume runner epoch", () => {
  it("将已有结果恢复为对应 terminal Task 状态", () => {
    expect(taskStatusForPersistedResult("READ_FAILED")).toBe("READ_FAILED");
    expect(taskStatusForPersistedResult("NEEDS_REVIEW")).toBe("NEEDS_REVIEW");
    expect(taskStatusForPersistedResult("COMPLIANT")).toBe("COMPLETED");
  });

  it("统一 extraction deadline 会取消浏览器操作并返回 LOAD_TIMEOUT", async () => {
    const cancel = vi.fn(async () => undefined);
    const never = new Promise<never>(() => undefined);
    await expect(
      runWithExtractionDeadline({
        operation: never,
        cancel,
        deadlineMs: 10,
        batchId: "batch-1",
        taskId: "task-70",
        runEpoch: 7,
      }),
    ).rejects.toMatchObject({ code: "LOAD_TIMEOUT" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("正常完成时不触发 cancellation", async () => {
    const cancel = vi.fn(async () => undefined);
    await expect(
      runWithExtractionDeadline({
        operation: Promise.resolve("done"),
        cancel,
        deadlineMs: 100,
        batchId: "batch-1",
        taskId: "task-1",
        runEpoch: 1,
      }),
    ).resolves.toBe("done");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("PAUSE 能立即中断等待中的 extraction 而不等待底层 Promise 退出", async () => {
    const controller = new AbortController();
    const pending = runWithExtractionDeadline({
      operation: new Promise<never>(() => undefined),
      cancel: vi.fn(async () => undefined),
      deadlineMs: 60_000,
      batchId: "batch-handoff",
      taskId: "task-handoff",
      runEpoch: 4,
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(
      AutomaticExtractionHandoffCancelledError,
    );
  });

  it("多次 CONTINUE 使用 generation latch 合并唤醒且不产生双 runner", () => {
    const state: { wakeGeneration?: number; runnerGeneration?: number } = {};
    requestRunnerWake(state);
    const firstRunner = claimRunnerWake(state);
    expect(firstRunner).toBe(1);
    expect(claimRunnerWake(state)).toBeNull();

    requestRunnerWake(state);
    requestRunnerWake(state);
    requestRunnerWake(state);
    expect(claimRunnerWake(state)).toBeNull();
    expect(completeRunnerWake(state, firstRunner!)).toBe(true);

    const nextRunner = claimRunnerWake(state);
    expect(nextRunner).toBe(4);
    expect(completeRunnerWake(state, nextRunner!)).toBe(false);
  });

  it("XHS context close 与下一代 launch 通过 closePromise 串行", () => {
    const browser = readFileSync(
      path.join(root, "lib/automation/browser.ts"),
      "utf8",
    );
    expect(browser).toContain("closePromise?: Promise<void>");
    expect(browser).toContain("if (state.closePromise) await state.closePromise");
    expect(browser).toContain("await launching?.catch(() => undefined)");
  });

  it("Schema 与 Migration 只新增兼容 epoch 字段", () => {
    const sqliteSchema = readFileSync(
      path.join(root, "prisma/schema.prisma"),
      "utf8",
    );
    const postgresSchema = readFileSync(
      path.join(root, "prisma/schema.postgresql.prisma"),
      "utf8",
    );
    const migration = readFileSync(
      path.join(
        root,
        "prisma/migrations/202608190001_pause_resume_run_epoch/migration.sql",
      ),
      "utf8",
    );
    for (const schema of [sqliteSchema, postgresSchema]) {
      expect(schema).toContain("claimEpoch         Int?");
      expect(schema).toContain("runEpoch         Int           @default(0)");
    }
    expect(migration).toContain('ADD COLUMN "runEpoch"');
    expect(migration).toContain('ADD COLUMN "claimEpoch"');
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE|INSERT)\b/u);
  });

  it("Result transaction 在创建结果前锁定并验证 execution lease", () => {
    const auditService = readFileSync(
      path.join(root, "lib/audit-service.ts"),
      "utf8",
    );
    const transaction = auditService.indexOf(
      "const result = await prisma.$transaction",
    );
    const guard = auditService.indexOf("lockValidExecutionLease", transaction);
    const create = auditService.indexOf("tx.auditResult.create", transaction);
    expect(transaction).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(transaction);
    expect(create).toBeGreaterThan(guard);
  });

  it("Desktop 通过 Electron 单实例锁阻止第二主进程", () => {
    const desktop = readFileSync(
      path.join(root, "desktop/main.cjs"),
      "utf8",
    );
    expect(desktop).toContain("app.requestSingleInstanceLock()");
    expect(desktop).toContain('app.on("second-instance"');
  });
});
