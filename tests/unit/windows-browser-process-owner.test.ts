import { describe, expect, it, vi } from "vitest";
import {
  exactBrowserProfileArgument, parseWindowsCommandLine,
  authorizeInitialWindowsBrowserOwners, authorizeWindowsBrowserDescendants,
  releaseWindowsBrowserProfileOwners, sameWindowsBrowserProcess,
  type WindowsBrowserProcessIdentity,
} from "@/lib/automation/windows-browser-process-owner";

const oldOwner: WindowsBrowserProcessIdentity = {
  pid: 101, birthStamp: "134000000000000001",
  executablePath: "C:\\Program Files\\Google\\Chrome\\chrome.exe",
  profilePath: "E:\\isolated browser\\xhs-profile",
  browserProcess: true, parentPid: 10,
};

describe("exact physical browser ownership fence", () => {
  it("parses quoted Windows arguments, not profile substrings or duplicate switches", () => {
    expect(parseWindowsCommandLine('"C:\\Program Files\\Chrome\\chrome.exe" "--user-data-dir=E:\\isolated browser\\xhs-profile" --start-minimized'))
      .toEqual(["C:\\Program Files\\Chrome\\chrome.exe", "--user-data-dir=E:\\isolated browser\\xhs-profile", "--start-minimized"]);
    expect(exactBrowserProfileArgument('chrome "--user-data-dir=E:\\isolated browser\\xhs-profile"', oldOwner.profilePath)).toBe(true);
    expect(exactBrowserProfileArgument('chrome --user-data-dir="E:\\isolated browser\\xhs-profile"', oldOwner.profilePath)).toBe(true);
    expect(exactBrowserProfileArgument('chrome "--user-data-dir=E:\\isolated browser\\xhs-profile-other"', oldOwner.profilePath)).toBe(false);
    expect(exactBrowserProfileArgument('chrome "--user-data-dir=E:\\isolated browser\\xhs-profile" --user-data-dir=E:\\other', oldOwner.profilePath)).toBe(false);
    expect(exactBrowserProfileArgument('chrome --url="E:\\isolated browser\\xhs-profile"', oldOwner.profilePath)).toBe(false);
  });

  it("requires all four immutable identity fields, including birth time", () => {
    expect(sameWindowsBrowserProcess(oldOwner, { ...oldOwner, executablePath: oldOwner.executablePath.toUpperCase() })).toBe(true);
    expect(sameWindowsBrowserProcess(oldOwner, { ...oldOwner, birthStamp: "134000000000000002" })).toBe(false);
    expect(sameWindowsBrowserProcess(oldOwner, { ...oldOwner, executablePath: "C:\\other\\chrome.exe" })).toBe(false);
    expect(sameWindowsBrowserProcess(oldOwner, { ...oldOwner, profilePath: "E:\\other" })).toBe(false);
  });

  it("authorizes new children only through a live captured root with ordered births", () => {
    const child = { ...oldOwner, pid: 102, parentPid: 101, browserProcess: false, birthStamp: "134000000000000002" };
    expect(authorizeWindowsBrowserDescendants([oldOwner, child], [oldOwner])).toEqual([oldOwner, child]);
    expect(() => authorizeWindowsBrowserDescendants([child], [oldOwner])).toThrow("未验证");
    expect(() => authorizeWindowsBrowserDescendants([oldOwner, { ...child, birthStamp: "134000000000000000" }], [oldOwner])).toThrow("后代");
    expect(() => authorizeWindowsBrowserDescendants([oldOwner, { ...child, browserProcess: true }], [oldOwner])).toThrow("未验证");
    expect(() => authorizeInitialWindowsBrowserOwners([oldOwner, { ...oldOwner, pid: 103 }])).toThrow("唯一");
  });

  it("force-closes only captured old identities and proves zero physical owners before release", async () => {
    let live = true;
    const probe = vi.fn((_executable: string, _profile: string, terminate?: WindowsBrowserProcessIdentity[]) => {
      if (terminate) { expect(terminate).toEqual([oldOwner]); live = false; }
      return live ? [oldOwner] : [];
    });
    await releaseWindowsBrowserProfileOwners(oldOwner.executablePath, oldOwner.profilePath, [oldOwner], probe);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(probe.mock.calls.at(-1)?.[2]).toBeUndefined();
    expect(live).toBe(false);
  });

  it.each([
    { ...oldOwner, birthStamp: "134000000000000002" },
    { ...oldOwner, pid: 102 },
    { ...oldOwner, executablePath: "C:\\other\\chrome.exe" },
    { ...oldOwner, profilePath: "E:\\other" },
  ])("fails closed for PID reuse, newer owner or changed executable/profile without any termination", async unknown => {
    const probe = vi.fn(() => [unknown]);
    await expect(releaseWindowsBrowserProfileOwners(oldOwner.executablePath, oldOwner.profilePath, [oldOwner], probe))
      .rejects.toThrow("未验证");
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
