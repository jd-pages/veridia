import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

import {
  inspectDesktopNodeRuntime,
  prepareDesktopNodeRuntime,
  type DesktopNodeRuntimeRequirements,
} from "../../scripts/desktop-node-runtime.mjs";

const temporaryRoots: string[] = [];

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function temporaryRuntimeRoot() {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "veridia-desktop-node-test-"),
  );
  temporaryRoots.push(projectRoot);
  return {
    projectRoot,
    destinationRoot: path.join(projectRoot, "desktop-runtime", "node"),
  };
}

async function fixture(executable = Buffer.from("fixture node executable")) {
  const version = "99.1.2";
  const archiveName = `node-v${version}-win-x64.zip`;
  const zip = new JSZip();
  zip.file(`node-v${version}-win-x64/node.exe`, executable);
  const archive = await zip.generateAsync({ type: "nodebuffer" });
  const requirements: DesktopNodeRuntimeRequirements = {
    version,
    versionTag: `v${version}`,
    platform: "win32",
    architecture: "x64",
    archiveName,
    archiveSha256: sha256(archive),
    executableSha256: sha256(executable),
    distributionRoot: `https://nodejs.example/dist/v${version}`,
  };
  return { archive, executable, requirements };
}

function response(value: Buffer | string, status = 200) {
  return new Response(
    typeof value === "string" ? value : Uint8Array.from(value).buffer,
    { status },
  );
}

function officialFetch(
  requirements: DesktopNodeRuntimeRequirements,
  archive: Buffer,
) {
  return vi.fn(async (url: string | URL | Request) => {
    const value = String(url);
    if (value.endsWith("/SHASUMS256.txt")) {
      return response(
        `${requirements.archiveSha256}  ${requirements.archiveName}\n`,
      );
    }
    if (value.endsWith(`/${requirements.archiveName}`)) {
      return response(archive);
    }
    return response("not found", 404);
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Desktop bundled Node runtime provisioning", () => {
  it("A: 正确版本和 checksum 已存在时 PASS 且不重复下载", async () => {
    const { projectRoot, destinationRoot } = temporaryRuntimeRoot();
    const { executable, requirements } = await fixture();
    fs.mkdirSync(destinationRoot, { recursive: true });
    fs.writeFileSync(path.join(destinationRoot, "node.exe"), executable);
    const fetchImpl = vi.fn();

    const result = await prepareDesktopNodeRuntime({
      projectRoot,
      destinationRoot,
      requirements,
      platform: "win32",
      architecture: "x64",
      runVersion: () => requirements.versionTag,
      fetchImpl,
      output: vi.fn(),
    });

    expect(result.source).toBe("EXISTING");
    expect(result.version).toBe(requirements.versionTag);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("B: runtime 缺失时从锁定官方 archive 准备并校验", async () => {
    const { projectRoot, destinationRoot } = temporaryRuntimeRoot();
    const { archive, executable, requirements } = await fixture();
    const fetchImpl = officialFetch(requirements, archive);

    const result = await prepareDesktopNodeRuntime({
      projectRoot,
      destinationRoot,
      requirements,
      platform: "win32",
      architecture: "x64",
      runVersion: () => requirements.versionTag,
      fetchImpl,
      sleepImpl: async () => undefined,
      output: vi.fn(),
    });

    expect(result.source).toBe("DOWNLOAD");
    expect(result.version).toBe(requirements.versionTag);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(destinationRoot, "node.exe"))).toEqual(
      executable,
    );
  });

  it("C: 已存在的错误版本被确定性阻断且不会下载覆盖", async () => {
    const { projectRoot, destinationRoot } = temporaryRuntimeRoot();
    const { executable, requirements } = await fixture();
    fs.mkdirSync(destinationRoot, { recursive: true });
    fs.writeFileSync(path.join(destinationRoot, "node.exe"), executable);
    const fetchImpl = vi.fn();

    await expect(
      prepareDesktopNodeRuntime({
        projectRoot,
        destinationRoot,
        requirements,
        platform: "win32",
        architecture: "x64",
        runVersion: () => "v1.0.0",
        fetchImpl,
        output: vi.fn(),
      }),
    ).rejects.toMatchObject({
      stage: "DESKTOP_PREPARE",
      classification: "DETERMINISTIC",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("D: 官方 checksum 与锁定值不一致时硬阻断且不下载 archive", async () => {
    const { projectRoot, destinationRoot } = temporaryRuntimeRoot();
    const { requirements } = await fixture();
    const fetchImpl = vi.fn(async () =>
      response(`${"0".repeat(64)}  ${requirements.archiveName}\n`),
    );

    await expect(
      prepareDesktopNodeRuntime({
        projectRoot,
        destinationRoot,
        requirements,
        platform: "win32",
        architecture: "x64",
        runVersion: () => requirements.versionTag,
        fetchImpl,
        output: vi.fn(),
      }),
    ).rejects.toMatchObject({
      stage: "DESKTOP_PREPARE",
      classification: "DETERMINISTIC",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("D2: 下载 archive 内容与官方 checksum 不一致时硬阻断", async () => {
    const { projectRoot, destinationRoot } = temporaryRuntimeRoot();
    const { requirements } = await fixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          `${requirements.archiveSha256}  ${requirements.archiveName}\n`,
        ),
      )
      .mockResolvedValueOnce(response("corrupt archive"));

    await expect(
      prepareDesktopNodeRuntime({
        projectRoot,
        destinationRoot,
        requirements,
        platform: "win32",
        architecture: "x64",
        runVersion: () => requirements.versionTag,
        fetchImpl,
        output: vi.fn(),
      }),
    ).rejects.toMatchObject({
      stage: "DESKTOP_PREPARE",
      classification: "DETERMINISTIC",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(destinationRoot, "node.exe"))).toBe(false);
  });

  it("E: 下载网络 timeout 有限重试后归类 TRANSIENT_NETWORK", async () => {
    const { projectRoot, destinationRoot } = temporaryRuntimeRoot();
    const { requirements } = await fixture();
    const fetchImpl = vi.fn(async () => {
      const error = new Error("request aborted by timeout");
      error.name = "AbortError";
      throw error;
    });

    await expect(
      prepareDesktopNodeRuntime({
        projectRoot,
        destinationRoot,
        requirements,
        platform: "win32",
        architecture: "x64",
        runVersion: () => requirements.versionTag,
        fetchImpl,
        sleepImpl: async () => undefined,
        output: vi.fn(),
      }),
    ).rejects.toMatchObject({
      stage: "DESKTOP_PREPARE",
      classification: "TRANSIENT_NETWORK",
      maxAttempts: 2,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("F: Prepare 落盘后 node.exe 不可执行时清理并硬阻断", async () => {
    const { projectRoot, destinationRoot } = temporaryRuntimeRoot();
    const { archive, requirements } = await fixture();
    const fetchImpl = officialFetch(requirements, archive);

    await expect(
      prepareDesktopNodeRuntime({
        projectRoot,
        destinationRoot,
        requirements,
        platform: "win32",
        architecture: "x64",
        runVersion: () => {
          throw new Error("not executable");
        },
        fetchImpl,
        output: vi.fn(),
      }),
    ).rejects.toMatchObject({
      classification: "DETERMINISTIC",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(destinationRoot, "node.exe"))).toBe(false);
  });

  it("G: system Node 存在也不会在 bundled runtime 缺失时 fallback", async () => {
    const { projectRoot, destinationRoot } = temporaryRuntimeRoot();
    const { requirements } = await fixture();
    const runVersion = vi.fn();
    const fetchImpl = vi.fn(async () => {
      const error = new Error("network unavailable");
      error.name = "AbortError";
      throw error;
    });

    await expect(
      prepareDesktopNodeRuntime({
        projectRoot,
        destinationRoot,
        requirements,
        platform: "win32",
        architecture: "x64",
        runVersion,
        fetchImpl,
        sleepImpl: async () => undefined,
        output: vi.fn(),
      }),
    ).rejects.toMatchObject({ classification: "TRANSIENT_NETWORK" });
    expect(process.execPath).toBeTruthy();
    expect(runVersion).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(destinationRoot, "node.exe"))).toBe(false);
  });

  it("inspect 精确核对版本和 executable SHA-256", async () => {
    const { destinationRoot } = temporaryRuntimeRoot();
    const { executable, requirements } = await fixture();
    fs.mkdirSync(destinationRoot, { recursive: true });
    fs.writeFileSync(path.join(destinationRoot, "node.exe"), executable);

    expect(
      inspectDesktopNodeRuntime({
        destinationRoot,
        requirements,
        platform: "win32",
        architecture: "x64",
        runVersion: () => requirements.versionTag,
      }),
    ).toMatchObject({
      valid: true,
      version: requirements.versionTag,
      sha256: requirements.executableSha256,
    });
  });
});
