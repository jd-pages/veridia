import { describe, expect, it, vi } from "vitest";

import {
  createElectronDownloadOptions,
  fetchTextWithRetry,
  runReadOnlyNetworkCommand,
  runReleasePreflight,
  validateWarmupResult,
  validatePreflightSnapshot,
} from "../../scripts/release-preflight.mjs";
import { ReleaseStageError } from "../../scripts/release-failure.mjs";

function gitState(overrides: Record<string, unknown> = {}) {
  return {
    branch: "main",
    dirty: false,
    ahead: 0,
    behind: 0,
    head: "abc123",
    originHead: "abc123",
    sourceVersion: "1.1.13",
    lockVersion: "1.1.13",
    lockRootVersion: "1.1.13",
    electronVersion: "43.2.0",
    localTagExists: false,
    remoteTagExists: false,
    ...overrides,
  };
}

function warmupResult(
  overrides: Partial<{
    prerequisites: Array<{
      name: string;
      path: string;
      ready: boolean;
      integrity: string;
      cacheAction?: string;
    }>;
  }> = {},
) {
  return {
    electronVersion: "43.2.0",
    checksumUrl:
      "https://github.com/electron/electron/releases/download/v43.2.0/SHASUMS256.txt",
    elapsedMs: 25,
    prerequisites:
      overrides.prerequisites ||
      ["Electron ZIP", "NSIS", "nsis-resources", "winCodeSign", "7zip"].map(
        (name) => ({
          name,
          path: `C:\\cache\\${name}`,
          ready: true,
          integrity: "VERIFIED",
        }),
      ),
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    inspectGit: vi.fn().mockResolvedValue(gitState()),
    inspectGitHub: vi.fn().mockResolvedValue({
      repository: "jd-pages/veridia",
      targetReleaseExists: false,
    }),
    inspectGitHubHealth: vi.fn().mockResolvedValue({
      repository: "jd-pages/veridia",
      targetReleaseExists: false,
    }),
    inspectDesktop: vi.fn().mockResolvedValue({
      bundledNode: "node.exe",
      nodeVersion: "v24.14.0",
      prismaAlias: "prisma-alias.cjs",
      chromium: "chrome.exe",
    }),
    inspectSystem: vi.fn().mockResolvedValue({
      tempWritable: true,
      outputWritable: true,
      freeBytes: 20 * 1024 ** 3,
      port: 54321,
      livePids: [],
    }),
    warmup: vi.fn().mockResolvedValue(warmupResult()),
    ...overrides,
  };
}

describe("Release Preflight", () => {
  it("Git fetch Case A: Schannel once then success retries once and passes", async () => {
    const execute = vi.fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "schannel: failed to receive handshake; SSL/TLS connection failed" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    await expect(runReadOnlyNetworkCommand("git", ["fetch", "origin"], {
      commandResult: execute,
      sleep: async () => undefined,
    })).resolves.toMatchObject({ status: 0 });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("Git fetch Case B: two TLS failures block as TRANSIENT_NETWORK", async () => {
    const execute = vi.fn().mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "SSL/TLS connection failed",
    });
    await expect(runReadOnlyNetworkCommand("git", ["fetch", "origin"], {
      commandResult: execute,
      sleep: async () => undefined,
    })).rejects.toSatisfy((error: Error) =>
      error.message.includes("SSL/TLS") && execute.mock.calls.length === 2,
    );
  });

  it("Git fetch Case C: first success has no second attempt", async () => {
    const execute = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" });
    await runReadOnlyNetworkCommand("git", ["fetch", "origin"], {
      commandResult: execute,
      sleep: async () => undefined,
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("Git fetch Case D: Tag conflict is not retried", async () => {
    const execute = vi.fn().mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "Tag v1.1.15 exists",
    });
    await expect(runReadOnlyNetworkCommand("git", ["ls-remote"], {
      commandResult: execute,
      sleep: async () => undefined,
    })).rejects.toThrow("Tag v1.1.15 exists");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("healthy state passes and warms every official prerequisite", async () => {
    const deps = dependencies();
    const result = await runReleasePreflight(
      { root: process.cwd(), targetVersion: "1.1.13" },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.warmup.prerequisites).toHaveLength(5);
    expect(deps.warmup).toHaveBeenCalledOnce();
  });

  it("canonical ReleaseState is consumed without re-running Git/Release state discovery", async () => {
    const deps = dependencies({
      inspectGitHubHealth: vi.fn().mockResolvedValue({ repository: "jd-pages/veridia" }),
    });
    const result = await runReleasePreflight({
      root: process.cwd(),
      targetVersion: "1.1.15",
      repository: "jd-pages/veridia",
      releaseState: {
        stateType: "TARGET_VERSION",
        targetVersion: "1.1.15",
        sourceVersion: "1.1.15",
        workingTreeClean: true,
        localHead: "abc123",
        remoteMainHead: "abc123",
        ahead: 0,
        behind: 0,
        targetLocalTagExists: false,
        targetRemoteTagExists: false,
        targetReleaseExists: false,
      },
    }, deps);
    expect(result.success).toBe(true);
    expect(deps.inspectGit).not.toHaveBeenCalled();
    expect(deps.inspectGitHub).not.toHaveBeenCalled();
    expect(deps.inspectGitHubHealth).toHaveBeenCalledOnce();
  });

  it.each([
    ["Git dirty", { dirty: true }, "Git working tree is dirty"],
    ["remote behind", { behind: 1 }, "origin/main has 1 commit"],
    ["local ahead", { ahead: 1 }, "local main has 1 unpushed commit"],
    ["HEAD mismatch", { originHead: "def456" }, "do not match"],
    ["target local Tag exists", { localTagExists: true }, "already exists"],
    ["target remote Tag exists", { remoteTagExists: true }, "already exists"],
  ])("%s is blocked before warmup", async (_label, stateOverride, message) => {
    const deps = dependencies({
      inspectGit: vi.fn().mockResolvedValue(gitState(stateOverride)),
    });

    await expect(
      runReleasePreflight(
        { root: process.cwd(), targetVersion: "1.1.13" },
        deps,
      ),
    ).rejects.toThrow(message);
    expect(deps.warmup).not.toHaveBeenCalled();
  });

  it("target GitHub Release conflict is blocked", () => {
    expect(() =>
      validatePreflightSnapshot(
        {
          ...gitState(),
          targetReleaseExists: true,
        },
        "1.1.13",
      ),
    ).toThrow("GitHub Release v1.1.13 already exists");
  });

  it.each([
    ["GitHub auth unavailable", "ENVIRONMENT"],
    ["GitHub API ETIMEDOUT", "TRANSIENT_NETWORK"],
  ] as const)("%s is blocked with its real classification", async (message, classification) => {
    const deps = dependencies({
      inspectGitHub: vi.fn().mockRejectedValue(
        new ReleaseStageError({
          stage: "PREFLIGHT",
          classification,
          summary: message,
        }),
      ),
    });

    await expect(
      runReleasePreflight(
        { root: process.cwd(), targetVersion: "1.1.13" },
        deps,
      ),
    ).rejects.toMatchObject({ stage: "PREFLIGHT", classification });
  });

  it("bundled Node missing is blocked", async () => {
    const deps = dependencies({
      inspectDesktop: vi.fn().mockRejectedValue(
        new ReleaseStageError({
          stage: "PREFLIGHT",
          classification: "ENVIRONMENT",
          summary: "Desktop bundled Node is missing",
        }),
      ),
    });

    await expect(
      runReleasePreflight(
        { root: process.cwd(), targetVersion: "1.1.13" },
        deps,
      ),
    ).rejects.toThrow("Desktop bundled Node is missing");
  });

  it.each([
    ["Temp unwritable", "EACCES: Temp is not writable"],
    ["low disk", "Insufficient disk space: 1.00 GiB free"],
  ])("%s is blocked", async (_label, message) => {
    const deps = dependencies({
      inspectSystem: vi.fn().mockRejectedValue(
        new ReleaseStageError({
          stage: "PREFLIGHT",
          classification: "ENVIRONMENT",
          summary: message,
        }),
      ),
    });

    await expect(
      runReleasePreflight(
        { root: process.cwd(), targetVersion: "1.1.13" },
        deps,
      ),
    ).rejects.toThrow(message);
  });
});

describe("Release prerequisite warmup", () => {
  it("reuses the official SHASUM for the Electron downloader without weakening ZIP validation", () => {
    const zipName = "electron-v43.2.0-win32-x64.zip";
    const checksum = "a".repeat(64);

    expect(createElectronDownloadOptions(zipName, checksum)).toEqual({
      force: false,
      checksums: { [zipName]: checksum },
      downloadOptions: { timeout: { request: 15_000 } },
    });
  });

  it("complete cache validates quickly without weakening integrity", () => {
    expect(validateWarmupResult(warmupResult()).prerequisites).toHaveLength(5);
  });

  it("missing cache may pass only after official warmup returns verified paths", () => {
    const fetched = warmupResult();
    fetched.prerequisites = fetched.prerequisites.map((item) => ({
      ...item,
      cacheAction: "FETCHED",
    }));
    expect(validateWarmupResult(fetched).prerequisites.every((item) => item.ready)).toBe(
      true,
    );
  });

  it.each([
    ["partial cache", { ready: false, integrity: "MISSING" }, "not ready"],
    ["corrupt cache", { ready: false, integrity: "CORRUPT" }, "not ready"],
    ["checksum mismatch", { ready: true, integrity: "MISMATCH" }, "not ready"],
  ])("%s is never reported ready", (_label, override, message) => {
    const result = warmupResult();
    result.prerequisites[0] = { ...result.prerequisites[0], ...override };
    expect(() => validateWarmupResult(result)).toThrow(message);
  });

  it("checksum mismatch remains a deterministic integrity hard block", () => {
    const result = warmupResult();
    result.prerequisites[0] = {
      ...result.prerequisites[0],
      integrity: "MISMATCH",
    };

    expect(() => validateWarmupResult(result)).toThrowError(
      expect.objectContaining({
        stage: "PREREQUISITE_WARMUP",
        classification: "DETERMINISTIC_INTEGRITY",
      }),
    );
  });

  it("network timeout remains a blocking warmup failure", async () => {
    const deps = dependencies({
      warmup: vi.fn().mockRejectedValue(
        new ReleaseStageError({
          stage: "PREREQUISITE_WARMUP",
          classification: "TRANSIENT_NETWORK",
          summary: "Electron SHASUMS256.txt request ETIMEDOUT",
        }),
      ),
    });

    await expect(
      runReleasePreflight(
        { root: process.cwd(), targetVersion: "1.1.13" },
        deps,
      ),
    ).rejects.toMatchObject({
      stage: "PREREQUISITE_WARMUP",
      classification: "TRANSIENT_NETWORK",
    });
  });

  it("network timeout uses two bounded attempts and preserves the first failure", async () => {
    let attempts = 0;
    const attemptResults: Array<Record<string, unknown>> = [];
    const startedAt = performance.now();
    const neverRespond = vi.fn(
      async (_url: string, options: { signal: AbortSignal }) => {
        attempts += 1;
        return new Promise<Response>((_resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("TimeoutError: request timeout"), {
              name: "TimeoutError",
            })),
          );
        });
      },
    );

    await expect(
      fetchTextWithRetry("https://unreachable.invalid/file", {
        timeoutMs: 50,
        attempts: 2,
        fetchImpl: neverRespond,
        sleep: async () => undefined,
        onAttempt: (result) => attemptResults.push(result),
      }),
    ).rejects.toThrow("request timeout");
    expect(attempts).toBe(2);
    expect(attemptResults).toMatchObject([
      { attempt: 1, maxAttempts: 2, success: false, classification: "TRANSIENT_NETWORK" },
      { attempt: 2, maxAttempts: 2, success: false, classification: "TRANSIENT_NETWORK" },
    ]);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
