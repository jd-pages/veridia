/* eslint-disable @typescript-eslint/no-require-imports */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MANAGED_DIRECTORIES = ["data", "logs", "config", "sessions", "backups"];
const LOCATION_FILE = "data-location.json";
const LOCATION_INI_FILE = "data-location.ini";

function resolvePath(value) {
  return path.resolve(String(value || "").trim());
}

function comparablePath(value) {
  return resolvePath(value)
    .replace(/[\\/]+$/, "")
    .toLocaleLowerCase("en-US");
}

function isSameOrInside(parent, candidate) {
  const parentPath = comparablePath(parent);
  const candidatePath = comparablePath(candidate);
  return (
    candidatePath === parentPath ||
    candidatePath.startsWith(`${parentPath}${path.sep}`)
  );
}

function createDirectoryLayout(root) {
  const resolvedRoot = resolvePath(root);
  return {
    root: resolvedRoot,
    data: path.join(resolvedRoot, "data"),
    sessionsRoot: path.join(resolvedRoot, "sessions"),
    sessions: path.join(resolvedRoot, "sessions", "xiaohongshu-profile"),
    douyinSessions: path.join(resolvedRoot, "sessions", "douyin-profile"),
    config: path.join(resolvedRoot, "config"),
    backups: path.join(resolvedRoot, "backups"),
    logs: path.join(resolvedRoot, "logs"),
  };
}

function ensureManagedDirectories(root) {
  const layout = createDirectoryLayout(root);
  for (const key of [
    "root",
    "data",
    "sessionsRoot",
    "sessions",
    "douyinSessions",
    "config",
    "backups",
    "logs",
  ]) {
    fs.mkdirSync(layout[key], { recursive: true });
  }
  return layout;
}

function locationFiles(controlRoot) {
  const configRoot = path.join(resolvePath(controlRoot), "config");
  return {
    json: path.join(configRoot, LOCATION_FILE),
    ini: path.join(configRoot, LOCATION_INI_FILE),
  };
}

function readDataLocation(controlRoot) {
  const files = locationFiles(controlRoot);
  try {
    const parsed = JSON.parse(fs.readFileSync(files.json, "utf8"));
    if (typeof parsed.dataDirectory !== "string") return null;
    return resolvePath(parsed.dataDirectory);
  } catch {
    return null;
  }
}

function writeDataLocation(controlRoot, dataDirectory) {
  const files = locationFiles(controlRoot);
  const resolved = resolvePath(dataDirectory);
  fs.mkdirSync(path.dirname(files.json), { recursive: true });
  const payload = {
    schemaVersion: 1,
    dataDirectory: resolved,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(files.json, JSON.stringify(payload, null, 2), "utf8");
  // NSIS can read this pointer during uninstall without parsing JSON.
  const ini = `\uFEFF[VERIDIA]\r\nDataDirectory=${resolved}\r\n`;
  fs.writeFileSync(files.ini, ini, "utf16le");
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(
    path.join(resolved, ".veridia-data-root"),
    JSON.stringify({ application: "VERIDIA", schemaVersion: 1 }, null, 2),
    "utf8",
  );
  return payload;
}

function hasExistingVeridiaData(root) {
  const layout = createDirectoryLayout(root);
  return (
    fs.existsSync(path.join(layout.data, "veridia.db")) ||
    fs.existsSync(path.join(layout.config, "settings.json"))
  );
}

function isDriveRoot(candidate) {
  const parsed = path.parse(resolvePath(candidate));
  return comparablePath(parsed.root) === comparablePath(candidate);
}

function validateDataDirectory(candidate, options = {}) {
  if (!candidate || !String(candidate).trim()) {
    throw new Error("请选择数据保存位置。");
  }
  const target = resolvePath(candidate);
  if (!path.isAbsolute(target) || isDriveRoot(target)) {
    throw new Error("数据目录必须是磁盘中的具体文件夹，不能直接使用磁盘根目录。");
  }

  const forbiddenRoots = [
    options.installDirectory,
    options.applicationDirectory,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
  ].filter(Boolean);
  for (const forbidden of forbiddenRoots) {
    if (
      isSameOrInside(forbidden, target) ||
      isSameOrInside(target, forbidden)
    ) {
      if (
        process.env.ProgramFiles &&
        isSameOrInside(process.env.ProgramFiles, target)
      ) {
        throw new Error("数据目录不能位于 Program Files，请选择有写入权限的目录。");
      }
      if (
        process.env["ProgramFiles(x86)"] &&
        isSameOrInside(process.env["ProgramFiles(x86)"], target)
      ) {
        throw new Error("数据目录不能位于 Program Files，请选择有写入权限的目录。");
      }
      throw new Error("数据目录不能与软件安装目录相同或互相包含。");
    }
  }

  fs.mkdirSync(target, { recursive: true });
  const probe = path.join(
    target,
    `.veridia-write-test-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    fs.writeFileSync(probe, "VERIDIA", { flag: "wx" });
    fs.rmSync(probe, { force: true });
  } catch {
    try {
      fs.rmSync(probe, { force: true });
    } catch {
      // Preserve the original permission error below.
    }
    throw new Error("所选目录没有写入权限，请选择其他位置。");
  }
  return target;
}

function walkFiles(root, relativeRoot = "") {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relative = path.join(relativeRoot, entry.name);
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkFiles(absolute, relative));
    } else if (entry.isFile()) {
      const buffer = fs.readFileSync(absolute);
      result.push({
        path: relative.replaceAll("\\", "/"),
        size: buffer.byteLength,
        sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      });
    }
  }
  return result;
}

function managedManifest(root) {
  const result = [];
  for (const directory of MANAGED_DIRECTORIES) {
    const absolute = path.join(resolvePath(root), directory);
    for (const item of walkFiles(absolute, directory)) result.push(item);
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function copyManagedData(sourceRoot, targetRoot) {
  const source = resolvePath(sourceRoot);
  const target = resolvePath(targetRoot);
  const entries = fs.existsSync(target) ? fs.readdirSync(target) : [];
  if (entries.length > 0) {
    throw new Error("目标目录不是空目录，请选择新的空文件夹。");
  }

  const stage = `${target}.veridia-migration-${crypto.randomUUID()}`;
  fs.mkdirSync(stage, { recursive: true });
  try {
    for (const directory of MANAGED_DIRECTORIES) {
      const from = path.join(source, directory);
      if (!fs.existsSync(from)) continue;
      fs.cpSync(from, path.join(stage, directory), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    const sourceManifest = managedManifest(source);
    const targetManifest = managedManifest(stage);
    if (JSON.stringify(sourceManifest) !== JSON.stringify(targetManifest)) {
      throw new Error("迁移文件校验失败，原数据目录保持不变。");
    }
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(stage, target);
    return { sourceManifest, targetManifest };
  } catch (error) {
    if (fs.existsSync(stage)) {
      fs.rmSync(stage, { recursive: true, force: true });
    }
    throw error;
  }
}

module.exports = {
  MANAGED_DIRECTORIES,
  copyManagedData,
  createDirectoryLayout,
  ensureManagedDirectories,
  hasExistingVeridiaData,
  isSameOrInside,
  locationFiles,
  managedManifest,
  readDataLocation,
  resolvePath,
  validateDataDirectory,
  writeDataLocation,
};
