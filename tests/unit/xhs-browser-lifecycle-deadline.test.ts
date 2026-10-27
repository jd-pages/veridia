import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowsBrowserProfileOwnershipError } from "@/lib/automation/windows-browser-process-owner";
import { readE2ePrismaTransactionDiagnostics } from "@/lib/testing/prisma-transaction-diagnostics";
import { EventEmitter } from "node:events";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  prisma: {},
  // This fixture never installs a real Prisma singleton. Preserve the public
  // diagnostic API without inventing an observed zero-transaction ledger.
  getE2ePrismaTransactionDiagnostics: () => readE2ePrismaTransactionDiagnostics({}, true, {}),
}));

const automationGlobal = globalThis as typeof globalThis & {
  xhsBrowserManagerState?: Record<string, unknown>;
  douyinBrowserManagerState?: Record<string, unknown>;
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  delete automationGlobal.xhsBrowserManagerState;
  delete automationGlobal.douyinBrowserManagerState;
  vi.resetModules();
});

describe("XHS actual browser lifecycle bounded unresolved operations", () => {
  it.each(["page", "context"] as const)("captured %s close settles only its own pending CDP detach", async (target) => {
    vi.useFakeTimers(); vi.stubEnv("VERIDIA_E2E", "true");
    const session = Object.assign(new EventEmitter(), {
      send: vi.fn(async () => ({ windowId: 7 })),
      detach: vi.fn(() => new Promise<void>(() => undefined)),
    });
    const context = Object.assign(new EventEmitter(), { newCDPSession: async () => session });
    const page = Object.assign(new EventEmitter(), { context: () => context, isClosed: () => false });
    const state = { context, auditPage: page, lifecyclePendingOperations: new Map(),
      pageArbiter: { settleAndReconcile: async () => ({ active: true }) } };
    automationGlobal.xhsBrowserManagerState = state;
    const { keepXhsAuditPageInBackground } = await import("@/lib/automation/browser");
    const result = keepXhsAuditPageInBackground(page as never);
    await vi.advanceTimersByTimeAsync(501);
    expect(await result).toBe(true);
    expect(state.lifecyclePendingOperations.size).toBe(1);
    ({ page, context })[target].emit("close");
    await vi.advanceTimersByTimeAsync(1);
    expect(state.lifecyclePendingOperations.size).toBe(0);
    for (const emitter of [page, context, session]) expect(emitter.listenerCount("close")).toBe(0);
    expect(session.detach).toHaveBeenCalledTimes(1);
  });

  it("replays CI operation 333: generation 14 and unrelated close cannot clear generation 5 detach", async () => {
    vi.useFakeTimers(); vi.stubEnv("VERIDIA_E2E", "true");
    const session = Object.assign(new EventEmitter(), {
      send: vi.fn(async () => ({ windowId: 7 })),
      detach: vi.fn(() => new Promise<void>(() => undefined)),
    });
    const context = Object.assign(new EventEmitter(), { newCDPSession: async () => session });
    const page = Object.assign(new EventEmitter(), { context: () => context, isClosed: () => false });
    const state = { context, auditPage: page, lifecycleGeneration: 5, lifecycleOperationSequence: 328,
      lifecyclePendingOperations: new Map(), pageArbiter: { settleAndReconcile: async () => ({ active: true }) } };
    automationGlobal.xhsBrowserManagerState = state;
    const { keepXhsAuditPageInBackground } = await import("@/lib/automation/browser");
    const result = keepXhsAuditPageInBackground(page as never);
    await vi.advanceTimersByTimeAsync(501); expect(await result).toBe(true);
    const expected = { phase: "WINDOW_SET_CDP_DETACH", operationId: 333, lifecycleGeneration: 5, ownerGeneration: null };
    expect([...state.lifecyclePendingOperations.values()]).toEqual([expect.objectContaining(expected)]);
    const newerContext = Object.assign(new EventEmitter(), { newCDPSession: async () => session });
    state.lifecycleGeneration = 14; state.context = newerContext;
    newerContext.emit("close");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect([...state.lifecyclePendingOperations.values()]).toEqual([expect.objectContaining(expected)]);
    context.emit("close");
    await vi.advanceTimersByTimeAsync(1);
    expect(state.lifecyclePendingOperations.size).toBe(0);
    expect(state.context).toBe(newerContext);
    expect(session.detach).toHaveBeenCalledTimes(1);
    for (const emitter of [page, context, session]) expect(emitter.listenerCount("close")).toBe(0);
  });

  it("same CDP session close proves detach completion even when its RPC acknowledgement never arrives", async () => {
    vi.useFakeTimers();vi.stubEnv("VERIDIA_E2E", "true");
    const session = Object.assign(new EventEmitter(), { send: vi.fn(async () => ({ windowId: 7 })), detach: vi.fn(() => new Promise<void>(() => undefined)) });
    const context = { newCDPSession: async () => session };
    const page = { context: () => context, isClosed: () => false };
    const state = { context, auditPage: page, lifecyclePendingOperations: new Map(), pageArbiter: { settleAndReconcile: async () => ({ active: true }) } };
    automationGlobal.xhsBrowserManagerState = state;
    const { keepXhsAuditPageInBackground } = await import("@/lib/automation/browser");
    const result = keepXhsAuditPageInBackground(page as never);
    await vi.advanceTimersByTimeAsync(1);
    expect([...state.lifecyclePendingOperations.values()]).toEqual([expect.objectContaining({ phase: "WINDOW_SET_CDP_DETACH" })]);
    session.emit("close", session);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBe(true);expect(state.lifecyclePendingOperations.size).toBe(0);
    expect(session.listenerCount("close")).toBe(0);expect(session.detach).toHaveBeenCalledTimes(1);
  });

  it("detach timeout and another session close cannot erase the captured unresolved operation", async () => {
    vi.useFakeTimers();vi.stubEnv("VERIDIA_E2E", "true");
    const session = Object.assign(new EventEmitter(), { send: vi.fn(async () => ({ windowId: 7 })), detach: vi.fn(() => new Promise<void>(() => undefined)) });
    const context = { newCDPSession: async () => session }, page = { context: () => context, isClosed: () => false };
    const state = { context, auditPage: page, lifecyclePendingOperations: new Map(), pageArbiter: { settleAndReconcile: async () => ({ active: true }) } };
    automationGlobal.xhsBrowserManagerState = state;
    const { keepXhsAuditPageInBackground } = await import("@/lib/automation/browser");
    const result = keepXhsAuditPageInBackground(page as never);
    await vi.advanceTimersByTimeAsync(501);expect(await result).toBe(true);
    new EventEmitter().emit("close");
    expect(state.lifecyclePendingOperations.size).toBe(1);
    session.emit("close", session);await vi.advanceTimersByTimeAsync(1);
    expect(state.lifecyclePendingOperations.size).toBe(0);expect(session.detach).toHaveBeenCalledTimes(1);
  });

  it("captures the session close before the window operation finishes and before detach begins", async () => {
    vi.useFakeTimers();vi.stubEnv("VERIDIA_E2E", "true");
    const session = Object.assign(new EventEmitter(), { send: vi.fn(async (method: string) => {
      if (method === "Browser.setWindowBounds") session.emit("close", session);
      return { windowId: 7 };
    }), detach: vi.fn(() => new Promise<void>(() => undefined)) });
    const context = { newCDPSession: async () => session }, page = { context: () => context, isClosed: () => false };
    const state = { context, auditPage: page, lifecyclePendingOperations: new Map(), pageArbiter: { settleAndReconcile: async () => ({ active: true }) } };
    automationGlobal.xhsBrowserManagerState = state;
    const { keepXhsAuditPageInBackground } = await import("@/lib/automation/browser");
    const result = keepXhsAuditPageInBackground(page as never);
    await vi.advanceTimersByTimeAsync(501);expect(await result).toBe(true);
    expect(state.lifecyclePendingOperations.size).toBe(0);expect(session.listenerCount("close")).toBe(0);
  });

  it("adds truthful global registry/manager diagnostics only in E2E", async () => {
    vi.stubEnv("VERIDIA_E2E", "true");
    automationGlobal.xhsBrowserManagerState = {};
    automationGlobal.douyinBrowserManagerState = { lifecycleGeneration: 0, closing: false };
    const { getXhsAuditPageDiagnostics } = await import("@/lib/automation/browser");
    const diagnostics = await getXhsAuditPageDiagnostics();
    expect(diagnostics.globalRuntimeDiagnostics).toMatchObject({
      activeExtractionCount: 0, pendingCleanupBarrierCount: 0,
      effectiveRunnerCount: 0, pendingLifecycleOperationCount: 0,
      physicalCloseState: null, physicalCloseFencePresent: false,
      prismaTransactionDiagnostics: {
        measurement: "NOT_RUN", singletonRegistered: false,
        wrapperIntact: false, pendingTransactionCount: null,
      },
      platformBrowserManagers: { DOUYIN: { managerAvailable: true, contextPresent: false } },
    });
    delete automationGlobal.douyinBrowserManagerState;
    expect((await getXhsAuditPageDiagnostics()).globalRuntimeDiagnostics?.pendingLifecycleOperationCount).toBeNull();
    vi.stubEnv("VERIDIA_E2E", "false");
    expect(await getXhsAuditPageDiagnostics()).not.toHaveProperty("globalRuntimeDiagnostics");
  });

  it("bounds an unresolved window CDP request and detaches its captured session", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VERIDIA_E2E", "false");
    const detach = vi.fn(async () => undefined);
    const context = {
      pages: () => [page],
      newCDPSession: async () => ({
        send: () => new Promise<never>(() => undefined),
        detach,
      }),
    };
    const page = { isClosed: () => false, context: () => context, url: () => "about:blank" };
    automationGlobal.xhsBrowserManagerState = { context, auditPage: page };
    const { getXhsAuditPageDiagnostics } = await import("@/lib/automation/browser");
    const diagnostics = getXhsAuditPageDiagnostics();
    await vi.advanceTimersByTimeAsync(2_500);
    expect((await diagnostics).windowState).toBe("unknown");
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("consumes and detaches a CDP session returned after the window deadline", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VERIDIA_E2E", "false");
    let resolveSession!: (value: unknown) => void;
    const detach = vi.fn(async () => undefined);
    const send = vi.fn(async () => ({ bounds: { windowState: "normal" } }));
    const context = { pages: () => [page], newCDPSession: () => new Promise(resolve => { resolveSession = resolve; }) };
    const page = { isClosed: () => false, context: () => context, url: () => "about:blank" };
    automationGlobal.xhsBrowserManagerState = { context, auditPage: page };
    const { getXhsAuditPageDiagnostics } = await import("@/lib/automation/browser");
    const diagnostics = getXhsAuditPageDiagnostics();
    await vi.advanceTimersByTimeAsync(2_500);
    expect((await diagnostics).windowState).toBe("unknown");
    resolveSession({ send, detach });
    await vi.advanceTimersByTimeAsync(1);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("never mutates a window after a late CDP get returns to an expired operation", async () => {
    vi.useFakeTimers();
    let resolveWindow!: (value: unknown) => void;
    const send = vi.fn((method: string) => method === "Browser.getWindowForTarget"
      ? new Promise(resolve => { resolveWindow = resolve; }) : Promise.resolve({}));
    const detach = vi.fn(async () => undefined);
    const context = { newCDPSession: async () => ({ send, detach }) };
    const page = { isClosed: () => false, context: () => context };
    automationGlobal.xhsBrowserManagerState = {
      context, auditPage: page,
      pageArbiter: { settleAndReconcile: async () => ({ active: true }) },
    };
    const { keepXhsAuditPageInBackground } = await import("@/lib/automation/browser");
    const minimized = keepXhsAuditPageInBackground(page as never);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await minimized).toBe(false);
    resolveWindow({ windowId: 7 });
    await vi.advanceTimersByTimeAsync(1);
    expect(send.mock.calls.map(call => call[0])).toEqual(["Browser.getWindowForTarget"]);
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("bounds close rejection but retains the physical fence until the captured close actually completes", async () => {
    vi.useFakeTimers();
    let resolveClose!: () => void;
    const close = vi.fn(() => new Promise<void>(resolve => { resolveClose = resolve; }));
    automationGlobal.xhsBrowserManagerState = {
      context: { close },
      closeBrowser: close,
    };
    const { closeXhsBrowserContext } = await import("@/lib/automation/browser");
    const closing = closeXhsBrowserContext();
    const rejected = closing.catch(error => error);
    await vi.advanceTimersByTimeAsync(12_001);
    expect(close).toHaveBeenCalledTimes(1);
    expect(await rejected).toMatchObject({ code: "BROWSER_CONTROL_ERROR" });
    expect(automationGlobal.xhsBrowserManagerState?.physicalCloseFence).toBeInstanceOf(Promise);
    expect(automationGlobal.xhsBrowserManagerState?.profileLocked).toBe(true);
    resolveClose();
    await vi.advanceTimersByTimeAsync(1);
    expect(automationGlobal.xhsBrowserManagerState?.physicalCloseFence).toBeUndefined();
    expect(automationGlobal.xhsBrowserManagerState?.profileLocked).toBe(false);
  });

  it("does not erase unknown-owner physical failure or attempt a new browser launch", async () => {
    const failure = new WindowsBrowserProfileOwnershipError("unknown owner");
    const close = vi.fn(async () => { throw failure; });
    automationGlobal.xhsBrowserManagerState = { context: { close }, closeBrowser: close };
    const { closeXhsBrowserContext, getXhsAuditPage } = await import("@/lib/automation/browser");
    await expect(closeXhsBrowserContext()).rejects.toBe(failure);
    expect(automationGlobal.xhsBrowserManagerState?.physicalCloseState).toBe("FAILED");
    expect(automationGlobal.xhsBrowserManagerState?.profileLocked).toBe(true);
    await expect(getXhsAuditPage()).rejects.toMatchObject({ code: "BROWSER_CONTROL_ERROR" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(automationGlobal.xhsBrowserManagerState?.physicalCloseState).toBe("FAILED");
  });

  it("late old physical cleanup cannot close or reset an independently installed newer generation", async () => {
    let resolveClose!: () => void;
    const oldClose = vi.fn(() => new Promise<void>(resolve => { resolveClose = resolve; }));
    automationGlobal.xhsBrowserManagerState = { context: { close: oldClose }, closeBrowser: oldClose };
    const { closeXhsBrowserContext } = await import("@/lib/automation/browser");
    const closing = closeXhsBrowserContext();
    const newerClose = vi.fn(async () => undefined);
    const newerContext = { close: newerClose };
    const newerFence = Promise.resolve();
    Object.assign(automationGlobal.xhsBrowserManagerState!, {
      lifecycleGeneration: 2, context: newerContext, closeBrowser: newerClose,
      physicalCloseFence: newerFence, physicalCloseState: "PENDING", controlState: "READY",
    });
    resolveClose();
    await closing;
    expect(newerClose).not.toHaveBeenCalled();
    expect(automationGlobal.xhsBrowserManagerState?.context).toBe(newerContext);
    expect(automationGlobal.xhsBrowserManagerState?.physicalCloseFence).toBe(newerFence);
    expect(automationGlobal.xhsBrowserManagerState?.controlState).toBe("READY");
  });

  it("preserves the exact failing probeId and captured closing owner through the failed fence into the next task's control error", async () => {
    vi.stubEnv("VERIDIA_E2E", "true");
    // afterEach resets modules; use the same fresh error class as browser.ts.
    const { WindowsBrowserProfileOwnershipError: ProbeError } = await import("@/lib/automation/windows-browser-process-owner");
    const owner = { platform: "XIAOHONGSHU" as const, batchId: "prior-batch", taskId: "prior-task",
      ownerGeneration: 27, runEpoch: 1, claimEpoch: 1, wakeGeneration: null };
    const failure = new ProbeError("physical ownership unavailable", {
      phase: "PROFILE_OWNER_PROBE", reason: "NATIVE_PROBE_DEADLINE", probeId: "exact-probe-A", elapsedMs: 2000,
      nativeStage: "PROCESS_CENSUS_QUERY_ENTER", probeProcessId: 123, probeBirthStamp: "134000000000000001",
    });
    const close = vi.fn(async () => { throw failure; });
    automationGlobal.xhsBrowserManagerState = { context: { close }, closeBrowser: close, contextOwner: owner, browserProcessId: 456 };
    const { closeXhsBrowserContext, getXhsAuditPage, getXhsAuditPageDiagnostics } = await import("@/lib/automation/browser");
    await expect(closeXhsBrowserContext()).rejects.toBe(failure);
    const diagnostics = await getXhsAuditPageDiagnostics();
    expect(diagnostics.physicalCloseFailure).toMatchObject({ closingOwner: owner, diagnostic: { probeId: "exact-probe-A" } });
    await expect(getXhsAuditPage()).rejects.toMatchObject({ code: "BROWSER_CONTROL_ERROR", details: {
      browserControlDiagnostic: { nativeProbe: { probeId: "exact-probe-A" }, physicalCloseFailure: { closingOwner: owner } },
    } });
    expect(close).toHaveBeenCalledTimes(1);
    expect(automationGlobal.xhsBrowserManagerState?.physicalCloseState).toBe("FAILED");
  });
});
