import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowsBrowserProfileOwnershipError } from "@/lib/automation/windows-browser-process-owner";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {} }));

const automationGlobal = globalThis as typeof globalThis & { douyinBrowserManagerState?: Record<string, unknown> };
afterEach(() => {
  vi.useRealTimers();
  delete automationGlobal.douyinBrowserManagerState;
  vi.resetModules();
});

describe("Douyin shared-launcher physical Profile fence", () => {
  it("retains a physical ownership failure and never silently reacquires that Profile", async () => {
    const failure = new WindowsBrowserProfileOwnershipError("unverified physical owner");
    const close = vi.fn(async () => { throw failure; });
    automationGlobal.douyinBrowserManagerState = { context: { close }, closeBrowser: close };
    const { cancelDouyinActiveExtraction, getDouyinAuditPage } = await import("@/lib/automation/douyin-browser");
    await expect(cancelDouyinActiveExtraction()).rejects.toBe(failure);
    expect(automationGlobal.douyinBrowserManagerState?.physicalCloseState).toBe("FAILED");
    await expect(getDouyinAuditPage()).rejects.toMatchObject({ code: "BROWSER_CONTROL_ERROR" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(automationGlobal.douyinBrowserManagerState?.physicalCloseFence).toBeInstanceOf(Promise);
  });

  it("bounds public cancellation without clearing an unfinished captured physical close", async () => {
    vi.useFakeTimers();
    let resolveClose!: () => void;
    const close = vi.fn(() => new Promise<void>(resolve => { resolveClose = resolve; }));
    automationGlobal.douyinBrowserManagerState = { context: { close }, closeBrowser: close };
    const { cancelDouyinActiveExtraction } = await import("@/lib/automation/douyin-browser");
    const cancelled = cancelDouyinActiveExtraction().catch(error => error);
    await vi.advanceTimersByTimeAsync(12_001);
    expect(await cancelled).toBeInstanceOf(Error);
    expect(automationGlobal.douyinBrowserManagerState?.physicalCloseFence).toBeInstanceOf(Promise);
    resolveClose();
    await vi.advanceTimersByTimeAsync(1);
    expect(automationGlobal.douyinBrowserManagerState?.physicalCloseFence).toBeUndefined();
    expect(automationGlobal.douyinBrowserManagerState?.physicalCloseState).toBeUndefined();
  });

  it("late old physical close cannot mutate an independently installed new owner", async () => {
    let resolveClose!: () => void;
    const oldClose = vi.fn(() => new Promise<void>(resolve => { resolveClose = resolve; }));
    automationGlobal.douyinBrowserManagerState = { context: { close: oldClose }, closeBrowser: oldClose };
    const { cancelDouyinActiveExtraction } = await import("@/lib/automation/douyin-browser");
    const cancelled = cancelDouyinActiveExtraction();
    const newerClose = vi.fn(async () => undefined);
    const newerContext = { close: newerClose };
    const newerFence = Promise.resolve();
    Object.assign(automationGlobal.douyinBrowserManagerState!, {
      lifecycleGeneration: 2, context: newerContext, closeBrowser: newerClose,
      physicalCloseFence: newerFence, physicalCloseState: "PENDING", controlError: "new owner error",
    });
    resolveClose();
    await cancelled;
    expect(newerClose).not.toHaveBeenCalled();
    expect(automationGlobal.douyinBrowserManagerState?.context).toBe(newerContext);
    expect(automationGlobal.douyinBrowserManagerState?.physicalCloseFence).toBe(newerFence);
    expect(automationGlobal.douyinBrowserManagerState?.controlError).toBe("new owner error");
  });
});
