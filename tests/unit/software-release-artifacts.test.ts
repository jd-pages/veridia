import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import {
  softwareReleaseArtifactNames,
  validateSoftwareReleaseArtifacts,
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
});
