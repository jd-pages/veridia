import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

function hashFile(filePath, algorithm, encoding) {
  const hash = createHash(algorithm);
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest(encoding);
}

function yamlValue(value) {
  return String(value || "")
    .trim()
    .replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2");
}

function missingFileMessage(name) {
  if (name.endsWith(".blockmap")) {
    return `发布已停止：缺少 ${name}。\n请重新执行打包，确认 electron-builder 已生成 blockmap。`;
  }
  if (name === "latest.yml") {
    return "发布已停止：缺少 latest.yml。\n自动更新需要 latest.yml，否则客户端无法正确识别新版。";
  }
  return `发布已停止：缺少 ${name}。\n请重新执行软件打包后再发布。`;
}

export function softwareReleaseArtifactNames(version) {
  const installer = `VERIDIA-Setup-${version}.exe`;
  return [installer, `${installer}.blockmap`, "latest.yml"];
}

export function packageVersion(projectRoot) {
  return JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  ).version;
}

export function validateSoftwareReleaseArtifacts({
  projectRoot,
  version = packageVersion(projectRoot),
  directory = path.join(projectRoot, "release", version),
}) {
  const names = softwareReleaseArtifactNames(version);
  const files = names.map((name) => {
    const filePath = path.join(directory, name);
    if (!fs.existsSync(filePath)) throw new Error(missingFileMessage(name));
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error(`发布已停止：${name} 为空或不是有效文件。`);
    }
    return {
      name,
      path: filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: hashFile(filePath, "sha256", "hex"),
    };
  });

  const [installer, blockmap, latestFile] = files;
  let blockmapValue;
  try {
    blockmapValue = JSON.parse(
      gunzipSync(fs.readFileSync(blockmap.path)).toString("utf8"),
    );
  } catch (error) {
    throw new Error(
      `发布已停止：${blockmap.name} 不是有效的 electron-builder blockmap。`,
      { cause: error },
    );
  }
  if (!Array.isArray(blockmapValue.files) || blockmapValue.files.length === 0) {
    throw new Error(`发布已停止：${blockmap.name} 不包含有效的文件块信息。`);
  }

  const latest = fs.readFileSync(latestFile.path, "utf8");
  const latestVersion = yamlValue(
    latest.match(/^version:\s*(.+)$/mu)?.[1],
  );
  const latestPath = yamlValue(latest.match(/^path:\s*(.+)$/mu)?.[1]);
  const latestUrl = yamlValue(
    latest.match(/^\s*-\s*url:\s*(.+)$/mu)?.[1],
  );
  const latestSize = Number(
    latest.match(/^\s+size:\s*(\d+)$/mu)?.[1] || Number.NaN,
  );
  const latestSha512 = yamlValue(
    latest.match(/^\s+sha512:\s*(.+)$/mu)?.[1],
  );
  const actualSha512 = hashFile(installer.path, "sha512", "base64");
  if (
    latestVersion !== version ||
    latestPath !== installer.name ||
    latestUrl !== installer.name ||
    latestSize !== installer.size ||
    latestSha512 !== actualSha512
  ) {
    throw new Error(
      `发布已停止：latest.yml 与 ${installer.name} 的版本、文件名、大小或 SHA-512 不一致。`,
    );
  }
  const timestampToleranceMs = 2_000;
  if (
    latestFile.mtimeMs + timestampToleranceMs <
    Math.max(installer.mtimeMs, blockmap.mtimeMs)
  ) {
    throw new Error(
      "发布已停止：latest.yml 早于本次安装包或 blockmap，请重新执行打包。",
    );
  }

  return {
    version,
    directory,
    files,
    installerSha256: installer.sha256,
    latestValid: true,
    blockmapValid: true,
  };
}

export function formatArtifactSize(bytes) {
  return `${bytes} bytes (${(bytes / 1024 / 1024).toFixed(2)} MB)`;
}

function git(projectRoot, args) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

export function collectReleaseSourceFingerprint(projectRoot) {
  const files = git(projectRoot, ["ls-files", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  for (const relative of files) {
    const absolute = path.join(projectRoot, relative);
    hash.update(`${relative}\0`);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      hash.update(fs.readFileSync(absolute));
    } else {
      hash.update("<missing>");
    }
  }
  return hash.digest("hex");
}

export function artifactManifestPath(projectRoot, version) {
  return path.join(
    projectRoot,
    ".release-work",
    "checkpoints",
    `local-artifact-${version}.json`,
  );
}

export function writeReleaseArtifactManifest({
  projectRoot,
  version = packageVersion(projectRoot),
  directory = path.join(projectRoot, "release", version),
  buildTimestamp = new Date().toISOString(),
}) {
  const validation = validateSoftwareReleaseArtifacts({
    projectRoot,
    version,
    directory,
  });
  const document = {
    schemaVersion: 1,
    version,
    commitSha: git(projectRoot, ["rev-parse", "HEAD"]),
    releaseCommit: null,
    buildTimestamp,
    sourceFingerprint: collectReleaseSourceFingerprint(projectRoot),
    directory,
    files: validation.files.map((file) => ({
      name: file.name,
      size: file.size,
      sha256: file.sha256,
    })),
  };
  const output = artifactManifestPath(projectRoot, version);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return document;
}

export function bindArtifactManifestToReleaseCommit(
  projectRoot,
  version,
  releaseCommit,
) {
  const file = artifactManifestPath(projectRoot, version);
  if (!fs.existsSync(file)) throw new Error("Local artifact manifest is missing");
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  const currentFingerprint = collectReleaseSourceFingerprint(projectRoot);
  if (document.sourceFingerprint !== currentFingerprint) {
    throw new Error("Local artifact is STALE because source fingerprint changed");
  }
  const updated = { ...document, releaseCommit };
  fs.writeFileSync(file, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}

export function validateReleaseArtifactManifest({
  projectRoot,
  version = packageVersion(projectRoot),
  currentHead = git(projectRoot, ["rev-parse", "HEAD"]),
}) {
  const file = artifactManifestPath(projectRoot, version);
  if (!fs.existsSync(file)) return { status: "MISSING", valid: false, reasons: ["MANIFEST_MISSING"] };
  let document;
  try {
    document = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { status: "INVALID", valid: false, reasons: ["MANIFEST_INVALID"] };
  }
  const reasons = [];
  if (document.schemaVersion !== 1) reasons.push("SCHEMA_VERSION");
  if (document.version !== version) reasons.push("VERSION_CHANGED");
  if (![document.commitSha, document.releaseCommit].filter(Boolean).includes(currentHead)) {
    reasons.push("HEAD_CHANGED");
  }
  const sourceFingerprint = collectReleaseSourceFingerprint(projectRoot);
  if (document.sourceFingerprint !== sourceFingerprint) reasons.push("SOURCE_FINGERPRINT_CHANGED");
  let validation;
  try {
    validation = validateSoftwareReleaseArtifacts({
      projectRoot,
      version,
      directory: document.directory,
    });
  } catch {
    reasons.push("ARTIFACT_VALIDATION_FAILED");
  }
  if (validation) {
    const actual = new Map(validation.files.map((item) => [item.name, item]));
    for (const expected of document.files || []) {
      const item = actual.get(expected.name);
      if (!item || item.size !== expected.size || item.sha256 !== expected.sha256) {
        reasons.push(`ARTIFACT_CHANGED:${expected.name}`);
      }
    }
  }
  return {
    status: reasons.length === 0 ? "VERIFIED" : "STALE",
    valid: reasons.length === 0,
    reasons,
    manifest: document,
    sourceFingerprint,
  };
}
