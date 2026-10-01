import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserType } from "playwright";

const fixture = vi.hoisted(() => ({
  child: undefined as unknown,
  spawned: false,
  direct: false,
  ownerAlive: false,
  capture: vi.fn(),
  release: vi.fn(),
  removePort: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("node:fs", () => ({ default: { existsSync: () => true } }));
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  rm: fixture.removePort,
  readFile: vi.fn(async () => {
    if (fixture.spawned && fixture.direct) return "65535\n/test-endpoint";
    throw new Error("OWNED_TEST_PROFILE_PORT_ABSENT");
  }),
}));
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 1 })),
  spawn: vi.fn(() => { fixture.spawned = true; return fixture.child; }),
}));
vi.mock("@/lib/automation/windows-browser-process-owner", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/automation/windows-browser-process-owner")>(),
  captureWindowsBrowserProfileOwners: fixture.capture,
  releaseWindowsBrowserProfileOwners: fixture.release,
}));

const profile = "E:\\isolated-test\\xhs-profile";
const executable = "C:\\Chrome\\chrome.exe";
const owner = { pid: 101, parentPid: 71, browserProcess: true, birthStamp: "134000000000000001", executablePath: executable, profilePath: profile };

function browserFixture(hang = false) {
  const never = () => new Promise<never>(() => undefined);
  const browser = {
    isConnected: () => fixture.ownerAlive,
    version: () => "test-owned-browser",
    contexts: () => [context],
    newBrowserCDPSession: vi.fn(hang ? never : async () => ({ send: async () => undefined, detach: async () => undefined })),
    close: vi.fn(hang ? never : async () => { fixture.ownerAlive = false; }),
  };
  const context = {
    browser: () => browser,
    close: vi.fn(hang ? never : async () => { fixture.ownerAlive = false; }),
  };
  const chromium = {
    executablePath: () => executable,
    connectOverCDP: vi.fn(async () => { fixture.ownerAlive = true; return browser; }),
    launchPersistentContext: vi.fn(async () => { fixture.ownerAlive = true; return context; }),
  };
  return { browser, context, chromium: chromium as unknown as BrowserType };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("PLAYWRIGHT_EXECUTABLE_PATH", executable);
  fixture.spawned = false;
  fixture.direct = false;
  fixture.ownerAlive = false;
  fixture.capture.mockReset();
  fixture.release.mockReset();
  fixture.removePort.mockReset();
  fixture.capture.mockImplementation(async () => fixture.ownerAlive ? [owner] : []);
  fixture.release.mockImplementation(async (_executable, _profile, identities) => {
    if (identities.length) fixture.ownerAlive = false;
  });
  fixture.removePort.mockResolvedValue(undefined);
  const child = Object.assign(new EventEmitter(), {
    pid: 101, exitCode: 3 as number | null, signalCode: null,
    stderr: new EventEmitter(),
    kill: vi.fn(() => { child.exitCode = 0; child.emit("exit", 0); return true; }),
  });
  fixture.child = child;
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetModules(); });

describe("actual persistent Chromium close path", () => {
  it("bounds never-resolving context/protocol closes and confirms physical release before removing the port", async () => {
    const { launchWindowsHiddenChromium } = await import("@/lib/automation/windows-hidden-chromium");
    const { chromium, context, browser } = browserFixture(true);
    const connection = await launchWindowsHiddenChromium(chromium, profile);
    expect(connection.remoteDebuggingMode).toBe("playwright");
    fixture.removePort.mockClear();
    fixture.removePort.mockImplementation(async () => { expect(fixture.ownerAlive).toBe(false); });
    const closed = connection.close();
    await vi.advanceTimersByTimeAsync(4_000);
    await closed;
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(browser.newBrowserCDPSession).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(fixture.release).toHaveBeenLastCalledWith(executable, profile, [owner]);
    expect(fixture.ownerAlive).toBe(false);
    expect(fixture.removePort).toHaveBeenCalledTimes(1);
    const captures = fixture.capture.mock.calls.length;
    await connection.close();
    expect(fixture.capture).toHaveBeenCalledTimes(captures);
  });

  it("boundedly closes the captured fallback context even when owner capture fails", async () => {
    const { launchWindowsHiddenChromium } = await import("@/lib/automation/windows-hidden-chromium");
    const { WindowsBrowserProfileOwnershipError } = await import("@/lib/automation/windows-browser-process-owner");
    const { chromium, context } = browserFixture();
    const failure = new WindowsBrowserProfileOwnershipError("capture unavailable");
    fixture.capture.mockRejectedValue(failure);
    await expect(launchWindowsHiddenChromium(chromium, profile)).rejects.toBe(failure);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(fixture.release.mock.calls.filter(call => call[2].length > 0)).toHaveLength(0);
  });

  it("uses the captured spawn handle for direct capture failure and never kills a raw PID", async () => {
    const { launchWindowsHiddenChromium } = await import("@/lib/automation/windows-hidden-chromium");
    const { WindowsBrowserProfileOwnershipError } = await import("@/lib/automation/windows-browser-process-owner");
    const { chromium, browser } = browserFixture();
    fixture.direct = true;
    const child = fixture.child as { exitCode: number | null; kill: ReturnType<typeof vi.fn> };
    child.exitCode = null;
    fixture.capture.mockRejectedValue(new WindowsBrowserProfileOwnershipError("capture unavailable"));
    await expect(launchWindowsHiddenChromium(chromium, profile)).rejects.toThrow("capture unavailable");
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.exitCode).toBe(0);
  });

  it("consumes/detaches a late old close CDP session without any late Browser.close command", async () => {
    const { launchWindowsHiddenChromium } = await import("@/lib/automation/windows-hidden-chromium");
    const { chromium, browser } = browserFixture();
    let resolveSession!: (value: unknown) => void;
    browser.newBrowserCDPSession.mockImplementation(() => new Promise(resolve => { resolveSession = resolve; }) as never);
    const connection = await launchWindowsHiddenChromium(chromium, profile);
    const closed = connection.close();
    await vi.advanceTimersByTimeAsync(1_001);
    await closed;
    const detach = vi.fn(async () => undefined);
    const send = vi.fn(async () => undefined);
    resolveSession({ send, detach });
    await vi.advanceTimersByTimeAsync(1);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});
