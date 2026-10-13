import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: fixture.spawn }));
import { captureWindowsBrowserProfileOwners, WindowsBrowserProfileOwnershipError } from "@/lib/automation/windows-browser-process-owner";

beforeEach(() => { vi.useFakeTimers(); vi.stubEnv("VERIDIA_E2E", "true"); fixture.spawn.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it("同步EPERM按所有权失败安全阻断，不遗漏error事件、不重试、不放行未知Profile", async () => {
  fixture.spawn.mockImplementation(() => { throw Object.assign(new Error("spawn EPERM"), { code: "EPERM", syscall: "spawn" }); });
  const failure = await captureWindowsBrowserProfileOwners("E:\\isolated\\chrome.exe", "E:\\isolated\\owned-profile").catch(error => error);
  expect(failure).toBeInstanceOf(WindowsBrowserProfileOwnershipError);
  expect(failure.diagnostic).toMatchObject({ phase: "PROFILE_OWNER_PROBE", reason: "NATIVE_PROBE_SYNC_SPAWN_FAILED", nativeSpawnCode: "EPERM" });
  expect(fixture.spawn).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(JSON.stringify(failure.diagnostic)).not.toContain("EncodedCommand");
});

it("生产环境保留原同步spawn错误，本轮诊断不改变正式Runtime行为", async () => {
  vi.stubEnv("VERIDIA_E2E", "false");
  const original = Object.assign(new Error("spawn EPERM"), { code: "EPERM", syscall: "spawn" });
  fixture.spawn.mockImplementation(() => { throw original; });
  await expect(captureWindowsBrowserProfileOwners("E:\\isolated\\chrome.exe", "E:\\isolated\\owned-profile")).rejects.toBe(original);
  expect(fixture.spawn).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
