import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertIdleE2eBrowserTeardown, assertIsolatedE2eBrowserTeardown } from "@/lib/testing/e2e-browser-teardown";
import { POST } from "@/app/api/automation/session/route";

const fakeFiles = vi.hoisted(() => ({ link: false, dbLink: false, dbLinks: 1, profileLink: false, metadata: {} as Record<string, unknown>, real: (value: string) => value }));
vi.mock("node:fs", () => ({ default: {
  lstatSync: (value: string) => ({ isSymbolicLink: () => fakeFiles.link || (value.endsWith(".db") ? fakeFiles.dbLink : value.endsWith("-profile") ? fakeFiles.profileLink : false),
    isFile: () => value.endsWith(".db"), isDirectory: () => !value.endsWith(".db"), nlink: fakeFiles.dbLinks }),
  existsSync: () => true,
  realpathSync: (value: string) => fakeFiles.real(value),
  readFileSync: () => JSON.stringify(fakeFiles.metadata),
} }));
const browserCalls = vi.hoisted(() => ({ xhs: vi.fn(), douyin: vi.fn(), memory: vi.fn(), closeXhs: vi.fn(), closeDouyin: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/lib/api", () => ({
  requireApiUser: browserCalls.requireUser,
  withApiErrorBoundary: (operation: unknown) => operation,
  ok: (data: unknown) => Response.json({ success: true, data }),
  fail: (error: string, status = 400) => Response.json({ success: false, error }, { status }),
}));
vi.mock("@/lib/automation/browser", () => ({ getXhsSessionDiagnostics: browserCalls.xhs, getE2eBrowserTeardownRuntimeSnapshot: browserCalls.memory, closeXhsBrowserContext: browserCalls.closeXhs }));
vi.mock("@/lib/automation/douyin-browser", () => ({ getDouyinSessionDiagnostics: browserCalls.douyin, closeDouyinBrowserContext: browserCalls.closeDouyin }));
const run = path.resolve(".playwright/e2e-runs/unit-teardown");
const url = "http://127.0.0.1:34567/api/automation/session";
const idle = () => ({ effectiveRunnerCount: 0, activeExtractionCount: 0, pendingCleanupBarrierCount: 0,
  pendingLifecycleOperationCount: 0, physicalCloseState: null, physicalCloseFencePresent: false,
  prismaTransactionDiagnostics: { measurement: "AVAILABLE", singletonRegistered: true, wrapperIntact: true, pendingTransactionCount: 0 } });

beforeEach(() => {
  vi.clearAllMocks();
  browserCalls.requireUser.mockResolvedValue({ role: "ADMIN" });
  browserCalls.closeXhs.mockResolvedValue(undefined); browserCalls.closeDouyin.mockResolvedValue(undefined);
  fakeFiles.link = false; fakeFiles.dbLink = false; fakeFiles.dbLinks = 1; fakeFiles.profileLink = false; fakeFiles.real = value => value;
  const database = path.join(run, "veridia-e2e.db");
  fakeFiles.metadata = { schemaVersion: 2, databasePath: database, profilePath: path.join(run, "xhs-profile"),
    douyinProfilePath: path.join(run, "douyin-profile"), port: 34567, nextDistDir: ".playwright/next-e2e" };
  for (const [key, value] of Object.entries({ NODE_ENV: "test", VERIDIA_E2E: "true", VERIDIA_E2E_TEARDOWN_NONCE: "private-nonce",
    DATABASE_URL: `file:${database}`, E2E_DATABASE_URL: `file:${database}`, E2E_PORT: "34567",
    XHS_PROFILE_PATH: path.join(run, "xhs-profile"), DOUYIN_PROFILE_PATH: path.join(run, "douyin-profile") })) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());

describe("isolated E2E retained browser teardown guard", () => {
  it("requires the actual loopback run, private nonce, DB metadata and both isolated profiles", () => {
    expect(() => assertIsolatedE2eBrowserTeardown(url, "private-nonce")).not.toThrow();
    expect(() => assertIsolatedE2eBrowserTeardown(url.replace("127.0.0.1", "localhost"), "private-nonce")).not.toThrow();
  });
  it.each(["production", "flag", "nonce", "database", "profile", "port", "external-url", "relative-db", "other-root", "symlink", "db-link", "db-hardlink", "profile-junction", "realpath", "metadata", "formal-dist"])("rejects %s before browser close", kind => {
    let requestUrl = url, nonce = "private-nonce";
    if (kind === "production") vi.stubEnv("NODE_ENV", "production");
    if (kind === "flag") vi.stubEnv("VERIDIA_E2E", "false");
    if (kind === "nonce") nonce = "incorrect";
    if (kind === "database") vi.stubEnv("E2E_DATABASE_URL", "file:other.db");
    if (kind === "profile") vi.stubEnv("XHS_PROFILE_PATH", path.resolve("other-profile"));
    if (kind === "port") requestUrl = requestUrl.replace("34567", "34568");
    if (kind === "external-url") requestUrl = requestUrl.replace("127.0.0.1", "example.com");
    if (kind === "relative-db") { vi.stubEnv("DATABASE_URL", "file:relative.db"); vi.stubEnv("E2E_DATABASE_URL", "file:relative.db"); }
    if (kind === "other-root") { vi.stubEnv("DATABASE_URL", `file:${path.resolve("data/veridia-e2e.db")}`); vi.stubEnv("E2E_DATABASE_URL", process.env.DATABASE_URL!); }
    if (kind === "symlink") fakeFiles.link = true;
    if (kind === "db-link") fakeFiles.dbLink = true;
    if (kind === "db-hardlink") fakeFiles.dbLinks = 2;
    if (kind === "profile-junction") fakeFiles.profileLink = true;
    if (kind === "realpath") fakeFiles.real = value => value + "-different";
    if (kind === "metadata") fakeFiles.metadata.port = 34568;
    if (kind === "formal-dist") fakeFiles.metadata.nextDistDir = ".next";
    expect(() => assertIsolatedE2eBrowserTeardown(requestUrl, nonce)).toThrow();
  });
  it("accepts idle retained owners, but refuses missing or nonzero logical measurements and audit locks", () => {
    expect(() => assertIdleE2eBrowserTeardown(idle(), [{ auditLock: null }, { auditLock: null }])).not.toThrow();
    for (const key of ["effectiveRunnerCount", "activeExtractionCount", "pendingCleanupBarrierCount", "pendingLifecycleOperationCount"])
      for (const value of [undefined, null, 1, -1]) expect(() => assertIdleE2eBrowserTeardown({ ...idle(), [key]: value }, [{ auditLock: null }, { auditLock: null }])).toThrow();
    for (const state of [null, { ...idle(), physicalCloseState: "FAILED" }, { ...idle(), physicalCloseFencePresent: true }])
      expect(() => assertIdleE2eBrowserTeardown(state, [{ auditLock: null }, { auditLock: null }])).toThrow();
    for (const sessions of [[], [{ auditLock: null }], [{}, { auditLock: null }], [{ auditLock: {} }, { auditLock: null }]])
      expect(() => assertIdleE2eBrowserTeardown(idle(), sessions)).toThrow();
    for (const tx of [undefined, { ...idle().prismaTransactionDiagnostics, pendingTransactionCount: 1 }, { ...idle().prismaTransactionDiagnostics, wrapperIntact: false }])
      expect(() => assertIdleE2eBrowserTeardown({ ...idle(), prismaTransactionDiagnostics: tx }, [{ auditLock: null }, { auditLock: null }])).toThrow();
  });
});

describe("authenticated isolated browser close action", () => {
  const request = () => new Request(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "CLOSE_BROWSERS_FOR_E2E_TEARDOWN", teardownNonce: "private-nonce" }) });
  const diagnostics = (closed: boolean) => ({ sessions: [{ auditLock: null }, { auditLock: null }], globalRuntimeDiagnostics: { ...idle(),
    activeBrowserOwnerGenerations: closed ? [] : [3], platformBrowserManagers: {
      XIAOHONGSHU: { managerAvailable: true, contextPresent: !closed, browserConnected: !closed },
      DOUYIN: { managerAvailable: true, contextPresent: !closed, browserConnected: !closed },
    } } });
  beforeEach(() => {
    browserCalls.memory.mockReset().mockReturnValueOnce(diagnostics(false)).mockReturnValue(diagnostics(true));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());
  it("calls both existing physical close functions in order, never logout or relaunch", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { closed: true } });
    expect(browserCalls.closeXhs).toHaveBeenCalledTimes(1); expect(browserCalls.closeDouyin).toHaveBeenCalledTimes(1);
    expect(browserCalls.xhs).not.toHaveBeenCalled(); expect(browserCalls.douyin).not.toHaveBeenCalled();
    expect(browserCalls.closeXhs.mock.invocationCallOrder[0]).toBeLessThan(browserCalls.closeDouyin.mock.invocationCallOrder[0]);
  });
  it.each(["unauthenticated", "production", "busy", "locked", "failed-close", "retained-after-close"])("fails closed for %s", async kind => {
    if (kind === "unauthenticated") browserCalls.requireUser.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    if (kind === "production") vi.stubEnv("NODE_ENV", "production");
    if (kind === "busy") browserCalls.memory.mockReset().mockReturnValue({ ...diagnostics(false), globalRuntimeDiagnostics: { ...diagnostics(false).globalRuntimeDiagnostics, activeExtractionCount: 1 } });
    if (kind === "locked") browserCalls.memory.mockReset().mockReturnValue({ ...diagnostics(false), sessions: [{ auditLock: null }, { auditLock: { batchId: "active" } }] });
    if (kind === "failed-close") browserCalls.closeXhs.mockRejectedValueOnce(new Error("physical close failed"));
    if (kind === "retained-after-close") browserCalls.memory.mockReset().mockReturnValue(diagnostics(false));
    const response = await POST(request());
    expect(response.ok).toBe(false);
    if (["unauthenticated", "production", "busy", "locked"].includes(kind)) {
      expect(browserCalls.closeXhs).not.toHaveBeenCalled(); expect(browserCalls.closeDouyin).not.toHaveBeenCalled();
    }
    if (kind === "failed-close") expect(browserCalls.closeDouyin).not.toHaveBeenCalled();
  });
});
