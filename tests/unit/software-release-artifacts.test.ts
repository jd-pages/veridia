import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectGitRevisionSourceFingerprint,
  SOFTWARE_RELEASE_VALIDATION_MODES,
  softwareReleaseArtifactNames,
  validateReleaseArtifactManifest,
  validateSoftwareReleaseArtifacts,
  writeReleaseArtifactManifest,
} from "../../scripts/software-release-artifacts.mjs";

const temporaryDirectories: string[] = [];

function fixture(version = "1.1.0") {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-release-"));
  temporaryDirectories.push(projectRoot);
  const directory = path.join(projectRoot, "release", version);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ version }),
  );
  const [installerName, blockmapName] = softwareReleaseArtifactNames(version);
  const installer = Buffer.from("installer-content");
  fs.writeFileSync(path.join(directory, installerName), installer);
  fs.writeFileSync(
    path.join(directory, blockmapName),
    gzipSync(JSON.stringify({ version: "2", files: [{ name: "file", sizes: [1] }] })),
  );
  fs.writeFileSync(
    path.join(directory, "latest.yml"),
    [
      `version: ${version}`,
      "files:",
      `  - url: ${installerName}`,
      `    sha512: ${createHash("sha512").update(installer).digest("base64")}`,
      `    size: ${installer.length}`,
      `path: ${installerName}`,
      "",
    ].join("\n"),
  );
  return { projectRoot, directory, version, installerName, blockmapName };
}

function initializeGit(value: ReturnType<typeof fixture>) {
  fs.writeFileSync(path.join(value.projectRoot, "source.txt"), "source-v1");
  execFileSync("git", ["init"], { cwd: value.projectRoot });
  execFileSync("git", ["config", "user.email", "release-test@example.invalid"], {
    cwd: value.projectRoot,
  });
  execFileSync("git", ["config", "user.name", "VERIDIA Release Test"], {
    cwd: value.projectRoot,
  });
  execFileSync("git", ["add", "package.json", "source.txt"], { cwd: value.projectRoot });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: value.projectRoot });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: value.projectRoot,
    encoding: "utf8",
  }).trim();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("软件发布三件套", () => {
  it("缺少 exe 时停止", () => {
    const value = fixture();
    fs.rmSync(path.join(value.directory, value.installerName));
    expect(() => validateSoftwareReleaseArtifacts(value)).toThrow(
      `发布已停止：缺少 ${value.installerName}`,
    );
  });

  it("缺少 blockmap 时停止", () => {
    const value = fixture();
    fs.rmSync(path.join(value.directory, value.blockmapName));
    expect(() => validateSoftwareReleaseArtifacts(value)).toThrow(
      `发布已停止：缺少 ${value.blockmapName}`,
    );
  });

  it("缺少 latest.yml 时停止", () => {
    const value = fixture();
    fs.rmSync(path.join(value.directory, "latest.yml"));
    expect(() => validateSoftwareReleaseArtifacts(value)).toThrow(
      "发布已停止：缺少 latest.yml",
    );
  });

  it("三个文件齐全且元数据一致时才通过", () => {
    const value = fixture();
    const result = validateSoftwareReleaseArtifacts(value);
    expect(result.files.map((file) => file.name)).toEqual([
      value.installerName,
      value.blockmapName,
      "latest.yml",
    ]);
    expect(result.latestValid).toBe(true);
    expect(result.blockmapValid).toBe(true);
  });

  it("LOCAL_BUILD keeps a weak local mtime freshness guard", () => {
    const value = fixture();
    const old = new Date(Date.now() - 30_000);
    fs.utimesSync(path.join(value.directory, "latest.yml"), old, old);
    expect(() => validateSoftwareReleaseArtifacts({
      ...value,
      mode: SOFTWARE_RELEASE_VALIDATION_MODES.LOCAL_BUILD,
    })).toThrow("本地 latest.yml 早于本次安装包");
  });

  it("latest.yml 版本错误时停止", () => {
    const value = fixture();
    const latestPath = path.join(value.directory, "latest.yml");
    fs.writeFileSync(
      latestPath,
      fs.readFileSync(latestPath, "utf8").replace("version: 1.1.0", "version: 1.1.1"),
    );

    expect(() => validateSoftwareReleaseArtifacts(value)).toThrow(
      "latest.yml 与 VERIDIA-Setup-1.1.0.exe",
    );
  });

  it("产物 Manifest 绑定 Commit 和源码指纹，HEAD 内容变化后标记 STALE", () => {
    const value = fixture();
    initializeGit(value);

    const manifest = writeReleaseArtifactManifest(value);
    expect(manifest).toMatchObject({
      version: value.version,
      releaseCommit: null,
    });
    expect(validateReleaseArtifactManifest(value)).toMatchObject({
      status: "VERIFIED",
      valid: true,
    });

    fs.writeFileSync(path.join(value.projectRoot, "source.txt"), "source-v2");
    expect(validateReleaseArtifactManifest(value)).toMatchObject({
      status: "STALE",
      valid: false,
      reasons: expect.arrayContaining(["SOURCE_FINGERPRINT_CHANGED"]),
    });
  });

  it("REMOTE_DOWNLOAD ignores copied mtimes when Manifest content identity matches", () => {
    const value = fixture();
    const tagCommit = initializeGit(value);
    const manifest = writeReleaseArtifactManifest({ ...value, tagCommit });
    const copied = path.join(value.projectRoot, "downloaded");
    fs.cpSync(value.directory, copied, { recursive: true });
    const newest = new Date();
    const oldest = new Date(Date.now() - 30_000);
    fs.utimesSync(path.join(copied, value.installerName), newest, newest);
    fs.utimesSync(path.join(copied, value.blockmapName), newest, newest);
    fs.utimesSync(path.join(copied, "latest.yml"), oldest, oldest);

    expect(validateSoftwareReleaseArtifacts({
      projectRoot: value.projectRoot,
      version: value.version,
      directory: copied,
      mode: SOFTWARE_RELEASE_VALIDATION_MODES.REMOTE_DOWNLOAD,
      manifest,
      expectedTagCommit: tagCommit,
    })).toMatchObject({ mode: "REMOTE_DOWNLOAD", manifestValid: true });
  });

  it("REMOTE_DOWNLOAD blocks a wrong latest.yml SHA-512 and Installer size", () => {
    const wrongHash = fixture();
    const tagCommit = initializeGit(wrongHash);
    const manifest = writeReleaseArtifactManifest({ ...wrongHash, tagCommit });
    const latestPath = path.join(wrongHash.directory, "latest.yml");
    fs.writeFileSync(
      latestPath,
      fs.readFileSync(latestPath, "utf8").replace(/sha512: .+/u, "sha512: invalid"),
    );
    expect(() => validateSoftwareReleaseArtifacts({
      ...wrongHash,
      mode: SOFTWARE_RELEASE_VALIDATION_MODES.REMOTE_DOWNLOAD,
      manifest,
      expectedTagCommit: tagCommit,
    })).toThrow("SHA-512 不一致");

    const wrongSize = fixture();
    const secondCommit = initializeGit(wrongSize);
    const secondManifest = writeReleaseArtifactManifest({ ...wrongSize, tagCommit: secondCommit });
    fs.appendFileSync(path.join(wrongSize.directory, wrongSize.installerName), "changed");
    expect(() => validateSoftwareReleaseArtifacts({
      ...wrongSize,
      mode: SOFTWARE_RELEASE_VALIDATION_MODES.REMOTE_DOWNLOAD,
      manifest: secondManifest,
      expectedTagCommit: secondCommit,
    })).toThrow("大小或 SHA-512 不一致");
  });

  it("REMOTE_DOWNLOAD blocks Manifest Tag commit and source fingerprint mismatches", () => {
    const value = fixture();
    const tagCommit = initializeGit(value);
    const manifest = writeReleaseArtifactManifest({ ...value, tagCommit });
    expect(() => validateSoftwareReleaseArtifacts({
      ...value,
      mode: SOFTWARE_RELEASE_VALIDATION_MODES.REMOTE_DOWNLOAD,
      manifest: { ...manifest, tagCommit: "wrong-commit" },
      expectedTagCommit: tagCommit,
    })).toThrow("TAG_COMMIT");
    expect(() => validateSoftwareReleaseArtifacts({
      ...value,
      mode: SOFTWARE_RELEASE_VALIDATION_MODES.REMOTE_DOWNLOAD,
      manifest: { ...manifest, sourceFingerprint: "wrong-fingerprint" },
      expectedTagCommit: tagCommit,
    })).toThrow("SOURCE_FINGERPRINT");
    expect(manifest.sourceFingerprint).toBe(
      collectGitRevisionSourceFingerprint(value.projectRoot, tagCommit),
    );
  });

  it("REMOTE_DOWNLOAD blocks a locally old file whose Manifest hash no longer matches", () => {
    const value = fixture();
    const tagCommit = initializeGit(value);
    const manifest = writeReleaseArtifactManifest({ ...value, tagCommit });
    fs.appendFileSync(path.join(value.directory, "latest.yml"), "# stale copy\n");
    expect(() => validateSoftwareReleaseArtifacts({
      ...value,
      mode: SOFTWARE_RELEASE_VALIDATION_MODES.REMOTE_DOWNLOAD,
      manifest,
      expectedTagCommit: tagCommit,
    })).toThrow("ARTIFACT_IDENTITY:latest.yml");
  });
});
