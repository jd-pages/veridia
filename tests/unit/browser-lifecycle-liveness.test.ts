import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BROWSER_LIFECYCLE_CLEANUP_DEADLINE_MS,
  acquireBrowserOwner,
  authorizeBrowserCleanup,
  browserLifecycleCleanupDeadlineMs,
  getGenerationLifecycleDiagnostics,
  isStaleExtractionCompletion,
  requestOwnedExtractionCancellation,
  resetGenerationLifecycleForTesting,
  settleOwnedExtraction,
  startOwnedExtraction,
  trackOwnedExtraction,
  waitForOwnedExtractionCleanup,
  type OwnedExtractionHandle,
} from "@/lib/automation/generation-lifecycle";
import {
  AutomaticExtractionHandoffCancelledError,
  runWithExtractionDeadline,
} from "@/lib/automation/extraction-deadline";

const CLEANUP_DEADLINE_MS = 20;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function start(suffix: string, runEpoch = 1) {
  return startOwnedExtraction({
    platform: "XIAOHONGSHU",
    batchId: `batch-${suffix}`,
    taskId: `task-${suffix}`,
    runEpoch,
    claimEpoch: runEpoch,
    wakeGeneration: runEpoch,
  });
}

function cancel(
  handle: OwnedExtractionHandle,
  cleanup: () => Promise<void> = async () => undefined,
) {
  return requestOwnedExtractionCancellation(handle, cleanup, {
    deadlineMs: CLEANUP_DEADLINE_MS,
  });
}

function waitForNext(handle: OwnedExtractionHandle) {
  return waitForOwnedExtractionCleanup(handle.platform, {
    platform: handle.platform,
    batchId: `${handle.batchId}-next`,
    taskId: "QUEUE_HANDOFF",
    runEpoch: handle.runEpoch + 1,
    claimEpoch: handle.claimEpoch + 1,
    wakeGeneration: (handle.wakeGeneration ?? 0) + 1,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetGenerationLifecycleForTesting();
});

describe("Protected BROWSER_LIFECYCLE_CLEANUP_DEADLINE", () => {
  it("使用独立于 task deadline 的集中 Browser cleanup deadline", () => {
    expect(browserLifecycleCleanupDeadlineMs()).toBe(
      DEFAULT_BROWSER_LIFECYCLE_CLEANUP_DEADLINE_MS,
    );
    expect(DEFAULT_BROWSER_LIFECYCLE_CLEANUP_DEADLINE_MS).toBe(15_000);
  });

  it("环境 cleanup deadline 有 100ms 下限且非法值回退", () => {
    vi.stubEnv("AUTOMATION_BROWSER_CLEANUP_DEADLINE_MS", "1");
    expect(browserLifecycleCleanupDeadlineMs()).toBe(100);
    vi.stubEnv("AUTOMATION_BROWSER_CLEANUP_DEADLINE_MS", "invalid");
    expect(browserLifecycleCleanupDeadlineMs()).toBe(
      DEFAULT_BROWSER_LIFECYCLE_CLEANUP_DEADLINE_MS,
    );
  });

  it("normal operation settle 后不建立 cleanup barrier", async () => {
    const handle = start("normal");
    await trackOwnedExtraction(handle, Promise.resolve("done"));
    await Promise.resolve();
    const cleanup = vi.fn(async () => undefined);
    await requestOwnedExtractionCancellation(handle, cleanup, {
      deadlineMs: CLEANUP_DEADLINE_MS,
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(getGenerationLifecycleDiagnostics().pendingCleanupBarrierCount).toBe(0);
  });

  it("delayed operation 在 deadline 前 settle 时正常完成 cleanup", async () => {
    const operation = deferred();
    const cleanup = deferred();
    const handle = start("delayed-before-deadline");
    trackOwnedExtraction(handle, operation.promise);
    const barrier = cancel(handle, () => cleanup.promise);
    cleanup.resolve();
    operation.resolve();
    await expect(barrier).resolves.toBeUndefined();
    expect(getGenerationLifecycleDiagnostics().activeExtractionCount).toBe(0);
  });

  it("active never settles 时在 cleanup deadline 后废弃旧 generation", async () => {
    const handle = start("active-never");
    trackOwnedExtraction(handle, new Promise<never>(() => undefined));
    await expect(cancel(handle)).resolves.toBeUndefined();
    expect(isStaleExtractionCompletion(handle)).toBe(true);
    expect(
      getGenerationLifecycleDiagnostics().recentEvents.some(
        ({ event }) => event === "BROWSER_LIFECYCLE_CLEANUP_DEADLINE_EXCEEDED",
      ),
    ).toBe(true);
  });

  it("cleanup never settles 时 active 已结束仍在 deadline 后放行", async () => {
    const handle = start("cleanup-never");
    acquireBrowserOwner(handle);
    const barrier = cancel(handle, () => new Promise<never>(() => undefined));
    settleOwnedExtraction(handle);
    await expect(barrier).resolves.toBeUndefined();
    const diagnostics = getGenerationLifecycleDiagnostics();
    expect(diagnostics.pendingCleanupBarrierCount).toBe(0);
    expect(diagnostics.activeBrowserOwnerGenerations).toEqual([]);
    expect(
      diagnostics.recentEvents.some(({ event }) => event === "BROWSER_SESSION_POISONED"),
    ).toBe(true);
  });

  it("底层忽略 AbortSignal 时 signal 已取消且 recovery 有界", async () => {
    const handle = start("abort-ignored");
    trackOwnedExtraction(handle, new Promise<never>(() => undefined));
    await cancel(handle);
    expect(handle.signal.aborted).toBe(true);
    expect(handle.state).toBe("ABANDONED");
  });

  it("old success after timeout 不能重新成为 active generation", async () => {
    const operation = deferred<string>();
    const old = start("late-success", 1);
    trackOwnedExtraction(old, operation.promise);
    acquireBrowserOwner(old);
    await cancel(old);
    const current = start("late-success-current", 2);
    acquireBrowserOwner(current);
    operation.resolve("late");
    await operation.promise;
    await Promise.resolve();
    expect(isStaleExtractionCompletion(old)).toBe(true);
    expect(authorizeBrowserCleanup(old)).toBe(false);
    expect(authorizeBrowserCleanup(current)).toBe(true);
    settleOwnedExtraction(current);
  });

  it("old failure after timeout 被消费且不影响新 owner", async () => {
    const operation = deferred();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const old = start("late-failure", 1);
      trackOwnedExtraction(old, operation.promise);
      acquireBrowserOwner(old);
      await cancel(old);
      const current = start("late-failure-current", 2);
      acquireBrowserOwner(current);
      operation.reject(new Error("late stale failure"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      expect(authorizeBrowserCleanup(current)).toBe(true);
      settleOwnedExtraction(current);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("Pause with hung operation 的 cleanup barrier 有界", async () => {
    const handle = start("pause");
    trackOwnedExtraction(handle, new Promise<never>(() => undefined));
    await expect(cancel(handle)).resolves.toBeUndefined();
    expect(handle.signal.aborted).toBe(true);
  });

  it("Continue after hung operation 可越过旧 cleanup barrier", async () => {
    const handle = start("continue");
    trackOwnedExtraction(handle, new Promise<never>(() => undefined));
    const barrier = cancel(handle);
    const next = waitForNext(handle);
    await expect(Promise.all([barrier, next])).resolves.toEqual([undefined, undefined]);
  });

  it("Cancel with hung operation 在有界时间清空逻辑 active 状态", async () => {
    const handle = start("cancel");
    trackOwnedExtraction(handle, new Promise<never>(() => undefined));
    await cancel(handle);
    const diagnostics = getGenerationLifecycleDiagnostics();
    expect(diagnostics.activeExtractionCount).toBe(0);
    expect(diagnostics.pendingCleanupBarrierCount).toBe(0);
  });

  it("task deadline + hung operation 结束当前等待并最终清空 lifecycle", async () => {
    const handle = start("task-deadline");
    const operation = trackOwnedExtraction(
      handle,
      new Promise<never>(() => undefined),
    );
    await expect(
      runWithExtractionDeadline({
        operation,
        cancel: () => cancel(handle),
        deadlineMs: 5,
        batchId: handle.batchId,
        taskId: handle.taskId,
        runEpoch: handle.runEpoch,
        signal: handle.signal,
      }),
    ).rejects.toBeInstanceOf(AutomaticExtractionHandoffCancelledError);
    await waitForNext(handle);
    expect(getGenerationLifecycleDiagnostics().activeExtractionCount).toBe(0);
  });

  it("next task after hung operation 不再 starvation", async () => {
    const old = start("starvation", 1);
    trackOwnedExtraction(old, new Promise<never>(() => undefined));
    const nextStarted = waitForNext(old).then(() => start("starvation-next", 2));
    await cancel(old);
    const next = await nextStarted;
    expect(next.state).toBe("RUNNING");
    settleOwnedExtraction(next);
  });

  it("simultaneous cleanup attempts 共用一个 barrier", async () => {
    const handle = start("simultaneous");
    trackOwnedExtraction(handle, new Promise<never>(() => undefined));
    const cleanup = vi.fn(async () => undefined);
    const first = cancel(handle, cleanup);
    const second = cancel(handle, cleanup);
    expect(second).toBe(first);
    await first;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("cleanup rejection 被消费且 barrier 仍等待 active 的有限 deadline", async () => {
    const handle = start("cleanup-reject");
    trackOwnedExtraction(handle, new Promise<never>(() => undefined));
    await expect(
      cancel(handle, async () => {
        throw new Error("old cleanup failed");
      }),
    ).resolves.toBeUndefined();
    expect(
      getGenerationLifecycleDiagnostics().recentEvents.some(
        ({ event }) => event === "STALE_EXTRACTION_ERROR_IGNORED",
      ),
    ).toBe(true);
  });

  it("deadline poisoning 会释放旧 browser owner", async () => {
    const handle = start("owner-release");
    trackOwnedExtraction(handle, new Promise<never>(() => undefined));
    acquireBrowserOwner(handle);
    await cancel(handle);
    const diagnostics = getGenerationLifecycleDiagnostics();
    expect(diagnostics.activeBrowserOwnerGenerations).toEqual([]);
    expect(
      diagnostics.recentEvents.some(({ event }) => event === "BROWSER_SESSION_POISONED"),
    ).toBe(true);
  });

  it("late background cleanup settle 只记录 stale 且不释放新 owner", async () => {
    const cleanup = deferred();
    const old = start("background-old", 1);
    trackOwnedExtraction(old, new Promise<never>(() => undefined));
    acquireBrowserOwner(old);
    await cancel(old, () => cleanup.promise);
    const current = start("background-current", 2);
    acquireBrowserOwner(current);
    cleanup.resolve();
    await cleanup.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authorizeBrowserCleanup(current)).toBe(true);
    expect(
      getGenerationLifecycleDiagnostics().recentEvents.some(
        ({ event }) => event === "STALE_BROWSER_CLEANUP_SETTLED",
      ),
    ).toBe(true);
    settleOwnedExtraction(current);
  });

  it("repeated recovery 每代都能有界完成且 registry 不泄漏", async () => {
    for (let generation = 1; generation <= 3; generation += 1) {
      const handle = start(`repeat-${generation}`, generation);
      trackOwnedExtraction(handle, new Promise<never>(() => undefined));
      await cancel(handle);
    }
    const diagnostics = getGenerationLifecycleDiagnostics();
    expect(diagnostics.activeExtractionCount).toBe(0);
    expect(diagnostics.pendingCleanupBarrierCount).toBe(0);
    expect(diagnostics.activeBrowserOwnerGenerations).toEqual([]);
  });

  it("shutdown reset 会同步废弃 hung operation 并清空 ownership", () => {
    const handle = start("shutdown");
    trackOwnedExtraction(handle, new Promise<never>(() => undefined));
    acquireBrowserOwner(handle);
    resetGenerationLifecycleForTesting();
    expect(handle.state).toBe("ABANDONED");
    expect(getGenerationLifecycleDiagnostics()).toMatchObject({
      activeExtractionCount: 0,
      pendingCleanupBarrierCount: 0,
      activeBrowserOwnerGenerations: [],
    });
  });

  it("late settle after abandonment 不恢复 active 或 owner", async () => {
    const operation = deferred();
    const handle = start("late-settle");
    trackOwnedExtraction(handle, operation.promise);
    acquireBrowserOwner(handle);
    await cancel(handle);
    operation.resolve();
    await operation.promise;
    await Promise.resolve();
    expect(getGenerationLifecycleDiagnostics()).toMatchObject({
      activeExtractionCount: 0,
      pendingCleanupBarrierCount: 0,
      activeBrowserOwnerGenerations: [],
    });
  });
});
