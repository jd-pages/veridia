import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
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
import { isIdempotentQueuedContinueState } from "@/lib/automation/runtime-state";

const root = process.cwd();

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n/g, "\n");
}

function sourceFunction(source: string, name: string) {
  const file = ts.createSourceFile("lifecycle.ts", normalizeLineEndings(source), ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(statement =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!declaration || !ts.isFunctionDeclaration(declaration) || !declaration.body) {
    throw new Error(`Missing lifecycle function: ${name}`);
  }
  return { text: declaration.getText(file), body: declaration.body, file };
}

function expectOrdered(source: string, before: string, after: string) {
  const first = source.indexOf(before);
  const second = source.indexOf(after);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(second).toBeGreaterThanOrEqual(0);
  expect(second).toBeGreaterThan(first);
}

function assertXhsPhysicalCloseContract(source: string) {
  const ensure = sourceFunction(source, "ensureBrowserContext").text;
  expect(ensure).toContain("boundedBrowserControlOperation(state.physicalCloseFence!, XHS_PHYSICAL_CLOSE_TIMEOUT_MS)");
  expectOrdered(ensure, "PHYSICAL_CONTEXT_CLOSE_WAIT", "PREVIOUS_CONTEXT_CLOSE_WAIT");
  expectOrdered(ensure, "PREVIOUS_CONTEXT_CLOSE_WAIT", "if (browserControlAvailable())");
  const close = sourceFunction(source, "closeXhsBrowserContext").text;
  expectOrdered(close, "const closingOwner = state.contextOwner || state.launchOwner", "state.contextOwner = undefined");
  expectOrdered(close, 'observeLifecycleOperation("CONTEXT_CLOSE"', 'observeLifecycleOperation("CANCELLED_LAUNCH_WAIT"');
  expectOrdered(close, 'observeLifecycleOperation("CANCELLED_LAUNCH_WAIT"', "releaseBrowserOwner(closingOwner)");
  expect(close).toContain("if (!(error instanceof XhsPageGenerationInvalidatedError)) throw error");
  expectOrdered(close, "state.physicalCloseFence = closing", "boundedBrowserControlOperation(closing, XHS_PHYSICAL_CLOSE_TIMEOUT_MS)");
  expect(close).toContain("if (state.closePromise === barrier) state.closePromise = undefined");
}

function assertPersistentCloseContract(source: string) {
  const fallback = sourceFunction(source, "closePlaywrightPersistentContext");
  const awaits = fallback.body.statements.flatMap(statement =>
    ts.isExpressionStatement(statement) && ts.isAwaitExpression(statement.expression)
      ? [statement.expression.getText(fallback.file)] : []);
  const contextClose = awaits.findIndex(value => value.includes("settleWithin(context.close().catch(() => undefined), CLOSE_STEP_TIMEOUT_MS)"));
  const browserClose = awaits.findIndex(value => value.includes("closeBrowser(browser, null, profilePath, executablePath, capturedOwners, false)"));
  expect(contextClose).toBeGreaterThanOrEqual(0);
  expect(browserClose).toBeGreaterThan(contextClose);
  const close = sourceFunction(source, "closeBrowser").text;
  expect(close).toContain("CLOSE_STEP_TIMEOUT_MS");
  expectOrdered(close, "browser.close().catch(() => undefined)", "await waitForProfileRelease(profilePath, executablePath, capturedOwners)");
  expectOrdered(close, "await waitForProfileRelease(profilePath, executablePath, capturedOwners)", "await waitForBrowserDisconnected(browser)");
  const release = sourceFunction(source, "waitForProfileRelease").text;
  expectOrdered(release, "await releaseWindowsBrowserProfileOwners(executablePath, profilePath, capturedOwners)", "await rm(activePortPath");
  const launch = sourceFunction(source, "launchWindowsHiddenChromium").text;
  expect(launch).toMatch(/closePlaywrightPersistentContext\(\s*browser\.context,/u);
}

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

  it("QUEUED 且无活动 lease 的重复 CONTINUE 不再失效 runEpoch", () => {
    expect(
      isIdempotentQueuedContinueState({
        status: "QUEUED",
        currentTaskId: null,
        processingTaskCount: 0,
      }),
    ).toBe(true);
    expect(
      isIdempotentQueuedContinueState({
        status: "QUEUED",
        currentTaskId: "task-1",
        processingTaskCount: 1,
      }),
    ).toBe(false);
    expect(
      isIdempotentQueuedContinueState({
        status: "PAUSED",
        currentTaskId: null,
        processingTaskCount: 0,
      }),
    ).toBe(false);
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
    for (const source of [normalizeLineEndings(browser), normalizeLineEndings(browser).replace(/\n/g, "\r\n")]) {
      assertXhsPhysicalCloseContract(source);
    }
    expect(() => assertXhsPhysicalCloseContract(browser.replace("state.physicalCloseFence = closing;", "state.physicalCloseFence = undefined;"))).toThrow();
    expect(() => assertXhsPhysicalCloseContract(browser.replace("if (!(error instanceof XhsPageGenerationInvalidatedError)) throw error", "void error"))).toThrow();
  });

  it("静态源码 Contract 只归一化 CRLF 行尾", () => {
    const expected =
      "closePlaywrightPersistentContext(\n          browser.context,";
    const lfSource = expected;
    const crlfSource = expected.replace(/\n/g, "\r\n");
    const semanticNegative =
      "closePlaywrightPersistentContext(\r\n          browser.foo,";

    expect(normalizeLineEndings(lfSource)).toBe(expected);
    expect(normalizeLineEndings(crlfSource)).toBe(expected);
    expect(normalizeLineEndings(semanticNegative)).not.toContain(expected);
  });

  it("Playwright fallback 先关闭 Persistent Context 再释放 Profile", () => {
    const launcher = normalizeLineEndings(
      readFileSync(
        path.join(root, "lib/automation/windows-hidden-chromium.ts"),
        "utf8",
      ),
    );
    for (const source of [launcher, launcher.replace(/\n/g, "\r\n")]) assertPersistentCloseContract(source);
    expect(() => assertPersistentCloseContract(launcher.replace(
      "await releaseWindowsBrowserProfileOwners(executablePath, profilePath, capturedOwners);", "void capturedOwners;",
    ))).toThrow();
    const contextClose = "await settleWithin(context.close().catch(() => undefined), CLOSE_STEP_TIMEOUT_MS);";
    const browserClose = "await closeBrowser(browser, null, profilePath, executablePath, capturedOwners, false);";
    const swapped = launcher.replace(`${contextClose}\n  ${browserClose}`, `${browserClose}\n  ${contextClose}`);
    expect(swapped).not.toBe(launcher);
    expect(() => assertPersistentCloseContract(swapped)).toThrow();
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
