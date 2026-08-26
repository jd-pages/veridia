import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  recoverOrphanedRunnerWake,
  requestRunnerWake,
} from "@/lib/automation/runner-handoff";
import {
  acquireBrowserOwner,
  authorizeBrowserCleanup,
  getGenerationLifecycleDiagnostics,
  isStaleExtractionCompletion,
  requestOwnedExtractionCancellation,
  resetGenerationLifecycleForTesting,
  settleOwnedExtraction,
  startOwnedExtraction,
  trackOwnedExtraction,
  waitForOwnedExtractionCleanup,
} from "@/lib/automation/generation-lifecycle";

const root = process.cwd();

afterEach(() => {
  resetGenerationLifecycleForTesting();
});

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

  it("runner Promise 已消失时回收孤儿 generation claim 且不丢失后续 wake", () => {
    const state = { wakeGeneration: 8, runnerGeneration: 7 };

    expect(recoverOrphanedRunnerWake(state, true)).toBeNull();
    expect(state.runnerGeneration).toBe(7);
    expect(recoverOrphanedRunnerWake(state, false)).toBe(7);
    expect(state.runnerGeneration).toBeUndefined();
    expect(claimRunnerWake(state)).toBe(8);
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

  it("generation 1 延迟 cleanup 无权关闭 generation 2 browser owner", () => {
    const first = startOwnedExtraction({
      platform: "XIAOHONGSHU",
      batchId: "batch-1",
      taskId: "task-1",
      runEpoch: 1,
      claimEpoch: 1,
      wakeGeneration: 1,
    });
    const second = startOwnedExtraction({
      platform: "XIAOHONGSHU",
      batchId: "batch-1",
      taskId: "task-1",
      runEpoch: 2,
      claimEpoch: 2,
      wakeGeneration: 2,
    });
    acquireBrowserOwner(first);
    acquireBrowserOwner(second);

    expect(authorizeBrowserCleanup(first)).toBe(false);
    expect(authorizeBrowserCleanup(second)).toBe(true);
    expect(
      getGenerationLifecycleDiagnostics("XIAOHONGSHU").recentEvents.some(
        (entry) => entry.event === "STALE_BROWSER_CLEANUP_REJECTED",
      ),
    ).toBe(true);
    settleOwnedExtraction(first);
    settleOwnedExtraction(second);
  });

  it("PAUSE cleanup barrier 不阻塞控制响应但会阻止下一代 browser acquire", async () => {
    let settleOperation: () => void = () => undefined;
    const handle = startOwnedExtraction({
      platform: "XIAOHONGSHU",
      batchId: "batch-barrier",
      taskId: "task-barrier",
      runEpoch: 4,
      claimEpoch: 4,
      wakeGeneration: 4,
    });
    const operation = new Promise<void>((resolve) => {
      settleOperation = resolve;
    });
    trackOwnedExtraction(handle, operation);
    let finishCleanup: () => void = () => undefined;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );

    const barrier = requestOwnedExtractionCancellation(handle, cleanup);
    expect(handle.signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);

    let acquired = false;
    const waiting = waitForOwnedExtractionCleanup("XIAOHONGSHU", {
      platform: "XIAOHONGSHU",
      batchId: "batch-barrier",
      taskId: "QUEUE_HANDOFF",
      runEpoch: 5,
      claimEpoch: 5,
      wakeGeneration: 5,
    }).then(() => {
      acquired = true;
    });
    await Promise.resolve();
    expect(acquired).toBe(false);
    finishCleanup();
    await Promise.resolve();
    expect(acquired).toBe(false);
    settleOperation();
    await Promise.all([barrier, waiting]);
    expect(acquired).toBe(true);
    expect(
      getGenerationLifecycleDiagnostics("XIAOHONGSHU")
        .pendingCleanupBarrierCount,
    ).toBe(0);
  });

  it("底层 extraction 接收 AbortSignal 后真正 settle 且 registry 归零", async () => {
    const handle = startOwnedExtraction({
      platform: "XIAOHONGSHU",
      batchId: "batch-abort",
      taskId: "task-abort",
      runEpoch: 8,
      claimEpoch: 8,
      wakeGeneration: 8,
    });
    const operation = new Promise<void>((_resolve, reject) => {
      handle.signal.addEventListener(
        "abort",
        () => reject(new AutomaticExtractionHandoffCancelledError()),
        { once: true },
      );
    });
    trackOwnedExtraction(handle, operation);
    const observed = operation.catch((error) => error);
    await requestOwnedExtractionCancellation(handle, async () => undefined);

    expect(await observed).toBeInstanceOf(
      AutomaticExtractionHandoffCancelledError,
    );
    expect(isStaleExtractionCompletion(handle)).toBe(true);
    expect(
      getGenerationLifecycleDiagnostics("XIAOHONGSHU").activeExtractionCount,
    ).toBe(0);
  });

  it("旧 generation cleanup 失败不会拒绝 barrier 或吞掉下一次 runner wake", async () => {
    const handle = startOwnedExtraction({
      platform: "XIAOHONGSHU",
      batchId: "batch-cleanup-error",
      taskId: "task-cleanup-error",
      runEpoch: 9,
      claimEpoch: 9,
      wakeGeneration: 9,
    });
    const operation = new Promise<void>((_resolve, reject) => {
      handle.signal.addEventListener(
        "abort",
        () => reject(new AutomaticExtractionHandoffCancelledError()),
        { once: true },
      );
    });
    trackOwnedExtraction(handle, operation);
    void operation.catch(() => undefined);

    await expect(
      requestOwnedExtractionCancellation(handle, async () => {
        throw new Error("old context already closed");
      }),
    ).resolves.toBeUndefined();
    await expect(
      waitForOwnedExtractionCleanup("XIAOHONGSHU", {
        platform: "XIAOHONGSHU",
        batchId: "batch-next",
        taskId: "QUEUE_HANDOFF",
        runEpoch: 10,
        claimEpoch: 10,
        wakeGeneration: 10,
      }),
    ).resolves.toBeUndefined();
    expect(
      getGenerationLifecycleDiagnostics("XIAOHONGSHU").recentEvents.some(
        (entry) => entry.event === "STALE_EXTRACTION_ERROR_IGNORED",
      ),
    ).toBe(true);
  });

  it("旧 extraction abort 后晚到错误只属于 stale generation", async () => {
    const handle = startOwnedExtraction({
      platform: "XIAOHONGSHU",
      batchId: "batch-stale-error",
      taskId: "task-stale-error",
      runEpoch: 11,
      claimEpoch: 11,
      wakeGeneration: 11,
    });
    handle.abort();
    expect(isStaleExtractionCompletion(handle)).toBe(true);
    settleOwnedExtraction(handle);
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
