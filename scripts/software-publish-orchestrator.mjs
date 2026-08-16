import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  canonicalizeProjectPath,
  sameProjectPath,
} from "./testing/project-path.mjs";
import {
  classifyReleaseFailure,
  parseReleaseResult,
  redactReleaseText,
} from "./release-failure.mjs";

const scriptProjectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function discoverGitProjectRoot(candidateRoot) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: candidateRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  const gitRoot = result.status === 0 ? result.stdout.trim() : "";
  return gitRoot ? path.resolve(gitRoot) : candidateRoot;
}

const projectRoot = discoverGitProjectRoot(scriptProjectRoot);
const releaseWorkflow = "veridia-release.yml";
const dryRun = process.argv.includes("--dry-run");

export class SoftwarePublishError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{
   *   cause?: unknown,
   *   stage?: string,
   *   classification?: string,
   *   command?: string,
   *   detailLog?: string,
   *   target?: string,
   *   failedItem?: string
   * }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "SoftwarePublishError";
    this.code = code;
    this.stage = options.stage;
    this.classification = options.classification;
    this.command = options.command;
    this.detailLog = options.detailLog;
    this.target = options.target;
    this.failedItem = options.failedItem;
  }
}

export function formatSoftwarePublishFailure(error, logPath) {
  const message = redactReleaseText(
    error instanceof Error ? error.message : String(error),
  ).slice(0, 1_200);
  const stage = error instanceof SoftwarePublishError && error.stage
    ? error.stage
    : "RELEASE_ORCHESTRATION";
  const classification =
    error instanceof SoftwarePublishError && error.classification
      ? error.classification
      : classifyReleaseFailure(message);
  const lines = [
    "========================================",
    "VERIDIA 正式发布未完成",
    "========================================",
    `失败阶段：${stage}`,
    `错误类型：${classification}`,
    ...(error instanceof SoftwarePublishError && error.failedItem
      ? [`失败项目：${error.failedItem}`]
      : []),
    ...(error instanceof SoftwarePublishError && error.target
      ? [`目标：${error.target}`]
      : []),
    `错误摘要：${message}`,
    `详细日志：${
      error instanceof SoftwarePublishError && error.detailLog
        ? error.detailLog
        : logPath
    }`,
  ];
  const noRemoteMutationStages = new Set([
    "PREFLIGHT",
    "PREREQUISITE_WARMUP",
    "FULL",
    "LINT",
    "TYPECHECK",
    "UNIT_TEST",
    "E2E",
    "PRODUCTION_BUILD",
    "STANDALONE",
    "DATABASE",
    "SENSITIVE_SCAN",
    "DESKTOP_PREPARE",
    "PACKAGE",
    "INSTALLER_VERIFY",
    "VERSION_UPDATE",
    "RELEASE_COMMIT",
  ]);
  if (noRemoteMutationStages.has(stage)) {
    lines.push(
      "本次未执行：",
      "- Push main",
      "- 创建 / Push Tag",
      "- GitHub Release",
      "- 执行rules:publish",
    );
  } else if (stage === "PUSH_MAIN") {
    lines.push("本次未执行：", "- 创建 / Push Tag", "- GitHub Release");
  } else if (stage === "TAG" || stage === "PUSH_TAG") {
    lines.push("本次未宣告 GitHub Release 成功。");
  } else {
    lines.push("远端状态请以上方执行阶段和日志为准；脚本不会自动覆盖或回滚远端状态。");
  }
  return lines;
}

export function parseReleaseVersion(value) {
  const match = String(value || "").trim().match(/^(\d+)\.(\d+)\.(\d+)$/u);
  if (!match) {
    throw new SoftwarePublishError(
      "INVALID_VERSION",
      `版本号不是有效的语义化版本：${value || "空"}`,
    );
  }
  return match.slice(1).map(Number);
}

export function compareReleaseVersions(left, right) {
  const leftParts = parseReleaseVersion(left);
  const rightParts = parseReleaseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  return 0;
}

export function nextPatchVersion(value) {
  const [major, minor, patch] = parseReleaseVersion(value);
  return `${major}.${minor}.${patch + 1}`;
}

export function createSoftwarePublishPlan(input) {
  if (input.dirty) {
    throw new SoftwarePublishError(
      "DIRTY_WORKTREE",
      "检测到未提交修改，请先完成开发提交后再发布。",
    );
  }
  if (input.branch !== "main") {
    throw new SoftwarePublishError(
      "INVALID_BRANCH",
      "软件正式发布只能从 main 分支执行。",
    );
  }
  if (input.behind > 0) {
    throw new SoftwarePublishError(
      "BEHIND_REMOTE",
      "远程main存在本地尚未同步的提交，请先处理分支同步。",
    );
  }
  if (input.sourceVersion !== input.lockVersion) {
    throw new SoftwarePublishError(
      "VERSION_MISMATCH",
      `package.json（${input.sourceVersion}）与 package-lock.json（${input.lockVersion}）版本不一致。`,
    );
  }
  const sourceComparedWithRelease = compareReleaseVersions(
    input.sourceVersion,
    input.latestReleaseVersion,
  );
  const failedReservedVersion = sourceComparedWithRelease > 0
    && input.sourceVersion === input.latestTagVersion
    && input.sourceTagExists
    && !input.sourceReleaseExists
    && compareReleaseVersions(input.latestTagVersion, input.latestReleaseVersion) > 0
    ? input.sourceVersion
    : undefined;
  if (
    input.latestTagVersion !== input.latestReleaseVersion
    && !failedReservedVersion
  ) {
    throw new SoftwarePublishError(
      "RELEASE_TAG_MISMATCH",
      `GitHub Latest Release（${input.latestReleaseVersion}）与最新正式 Tag（${input.latestTagVersion}）不一致。`,
    );
  }
  if (sourceComparedWithRelease < 0) {
    throw new SoftwarePublishError(
      "SOURCE_VERSION_BEHIND",
      `源码版本 ${input.sourceVersion} 低于已发布版本 ${input.latestReleaseVersion}，发布已停止。`,
    );
  }
  if (input.commitsSinceRelease.length === 0) {
    return {
      kind: "none",
      currentVersion: input.latestReleaseVersion,
      sourceVersion: input.sourceVersion,
      ahead: input.ahead,
      behind: input.behind,
      commitsToPush: input.commitsToPush,
      commitsSinceRelease: input.commitsSinceRelease,
    };
  }

  const sourceIsPublished = sourceComparedWithRelease === 0;
  const versionChangeRequired = sourceIsPublished || Boolean(failedReservedVersion);
  const targetVersion = failedReservedVersion
    ? nextPatchVersion(failedReservedVersion)
    : sourceIsPublished
      ? nextPatchVersion(input.latestReleaseVersion)
      : input.sourceVersion;
  if (input.targetTagExists) {
    throw new SoftwarePublishError(
      "TARGET_TAG_EXISTS",
      `目标 Tag v${targetVersion} 已存在，拒绝覆盖。`,
    );
  }
  if (input.targetReleaseExists) {
    throw new SoftwarePublishError(
      "TARGET_RELEASE_EXISTS",
      `GitHub Release v${targetVersion} 已存在，拒绝重复发布。`,
    );
  }

  return {
    kind: "release",
    currentVersion: input.latestReleaseVersion,
    sourceVersion: input.sourceVersion,
    targetVersion,
    versionChangeRequired,
    failedReservedVersion,
    ahead: input.ahead,
    behind: input.behind,
    commitsToPush: input.commitsToPush,
    commitsSinceRelease: input.commitsSinceRelease,
  };
}

export async function executeSoftwarePublishPlan(plan, options) {
  if (options.dryRun || plan.kind === "none") {
    return { dryRun: options.dryRun, released: false };
  }
  let versionTouched = false;
  let versionCommitted = false;
  const executeStage = async (stage, operation) => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SoftwarePublishError && error.stage) throw error;
      throw new SoftwarePublishError(
        "RELEASE_STAGE_FAILED",
        error instanceof Error ? error.message : String(error),
        {
          cause: error,
          stage,
          classification: classifyReleaseFailure(error),
        },
      );
    }
  };
  try {
    if (options.operations.preflight) {
      await executeStage("PREFLIGHT", () => options.operations.preflight(plan));
    }
    versionTouched = true;
    await executeStage("VERSION_UPDATE", () => options.operations.updateVersion(plan));
    await executeStage("FULL", () => options.operations.validate(plan));
    await executeStage("RELEASE_COMMIT", () => options.operations.commitVersion(plan));
    versionCommitted = true;
    await executeStage("PUSH_MAIN", () => options.operations.pushMain(plan));
    await executeStage("PUSH_MAIN", () => options.operations.assertMainSynchronized(plan));
    await executeStage("TAG", () => options.operations.assertTargetAvailable(plan));
    await executeStage("TAG", () => options.operations.createTag(plan));
    await executeStage("PUSH_TAG", () => options.operations.pushTag(plan));
    const actions = await executeStage("GITHUB_ACTIONS", () =>
      options.operations.waitForActions(plan),
    );
    if (!actions.success) {
      throw new SoftwarePublishError(
        "ACTIONS_FAILED",
        `GitHub Actions 发布失败：${actions.url || "未提供运行地址"}`,
        { stage: "GITHUB_ACTIONS", classification: "DETERMINISTIC" },
      );
    }
    const release = await executeStage("REMOTE_RELEASE_VERIFY", () =>
      options.operations.verifyRelease(plan, actions),
    );
    return { dryRun: false, released: true, actions, release };
  } catch (error) {
    if (versionTouched && !versionCommitted) await options.operations.restoreVersion(plan);
    throw error;
  }
}

function timestamp() {
  return new Date().toISOString().replaceAll(/[:.]/gu, "-");
}

function createLogger() {
  const logDirectory = path.join(projectRoot, ".release-work", "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  const logPath = path.join(
    logDirectory,
    `software-release-${timestamp()}.log`,
  );
  function write(value = "") {
    const text = String(value);
    process.stdout.write(text);
    fs.appendFileSync(logPath, text, "utf8");
  }
  function line(value = "") {
    write(`${String(value)}\n`);
  }
  return { line, write, logPath };
}

function windowsCommand(executable, args) {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(executable)) {
    return { executable, args };
  }
  const quote = (value) => {
    const text = String(value);
    return /[\s"&|<>^]/u.test(text)
      ? `"${text.replaceAll('"', '""')}"`
      : text;
  };
  return {
    executable: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", ["call", executable, ...args].map(quote).join(" ")],
  };
}

function command(executable, args, options = {}) {
  const normalized = windowsCommand(executable, args);
  const result = spawnSync(normalized.executable, normalized.args, {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 100 * 1024 * 1024,
    timeout: options.timeoutMs,
    env: { ...process.env, ...options.env },
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (result.error) throw result.error;
  const stdoutRaw = result.stdout || "";
  const stderrRaw = result.stderr || "";
  const stdout = stdoutRaw.trim();
  const stderr = stderrRaw.trim();
  if (result.status !== 0 && !options.allowFailure) {
    throw new SoftwarePublishError(
      "COMMAND_FAILED",
      `${executable} ${args.join(" ")} 执行失败（退出码 ${result.status ?? "未知"}）${stderr ? `：${stderr}` : ""}`,
    );
  }
  return { status: result.status, stdout, stderr, stdoutRaw, stderrRaw };
}

function git(args, options) {
  return command("git", args, options);
}

function gh(args, options) {
  return command("gh", args, options);
}

export function assertProjectRootConsistency({
  scriptRoot,
  resolvedProjectRoot,
  gitRoot,
  workingDirectory,
}) {
  const mismatches = [
    ["发布脚本目录", scriptRoot],
    ["解析后的项目根", resolvedProjectRoot],
    ["当前工作目录", workingDirectory],
  ].filter(([, value]) => !sameProjectPath(value, gitRoot));
  if (mismatches.length === 0) return canonicalizeProjectPath(gitRoot);

  throw new SoftwarePublishError(
    "INVALID_PROJECT_ROOT",
    [
      `发布入口、当前目录与 Git 顶层根目录不一致。Git 根：${path.resolve(gitRoot)}`,
      ...mismatches.map(([label, value]) => `${label}：${path.resolve(value)}`),
      "请从当前 Git 仓库根目录运行发布入口。",
    ].join("\n"),
  );
}

function assertRequiredProjectRoot() {
  const actual = git(["rev-parse", "--show-toplevel"]).stdout;
  assertProjectRootConsistency({
    scriptRoot: scriptProjectRoot,
    resolvedProjectRoot: projectRoot,
    gitRoot: actual,
    workingDirectory: process.cwd(),
  });
}

function assertCommandAvailable(name, friendlyName) {
  const result = command("where.exe", [name], { allowFailure: true });
  if (result.status !== 0) {
    throw new SoftwarePublishError(
      "MISSING_COMMAND",
      `未找到 ${friendlyName}（${name}），发布已停止。`,
    );
  }
}

function repositoryFromOrigin() {
  const origin = git(["remote", "get-url", "origin"]).stdout;
  const match = origin.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/iu);
  if (!match) {
    throw new SoftwarePublishError(
      "INVALID_ORIGIN",
      `origin 不是可识别的 GitHub 仓库：${origin}`,
    );
  }
  return match[1];
}

function strictTagVersion(value) {
  const version = String(value || "").replace(/^v/u, "");
  try {
    parseReleaseVersion(version);
    return version;
  } catch {
    return null;
  }
}

function releaseExists(repository, version) {
  const result = gh(
    ["api", `repos/${repository}/releases/tags/v${version}`, "--silent"],
    { allowFailure: true },
  );
  if (result.status === 0) return true;
  if (/HTTP 404|Not Found|release not found/iu.test(result.stderr)) return false;
  throw new SoftwarePublishError(
    "GITHUB_LOOKUP_FAILED",
    `无法确认 GitHub Release v${version} 是否存在：${result.stderr || "未知网络错误"}`,
  );
}

function latestRelease(repository) {
  const value = JSON.parse(
    gh([
      "release",
      "view",
      "--repo",
      repository,
      "--json",
      "tagName,name,isDraft,isPrerelease,url",
    ]).stdout,
  );
  const version = strictTagVersion(value.tagName);
  if (!version || value.isDraft || value.isPrerelease) {
    throw new SoftwarePublishError(
      "INVALID_LATEST_RELEASE",
      "GitHub Latest Release 不是有效的正式语义化版本。",
    );
  }
  return { ...value, version };
}

function readVersions() {
  const packageValue = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  );
  const lockValue = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package-lock.json"), "utf8"),
  );
  return {
    sourceVersion: packageValue.version,
    lockVersion: lockValue.version,
    lockRootVersion: lockValue.packages?.[""]?.version,
  };
}

function lines(value) {
  return String(value || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function targetTagExists(version) {
  if (git(["tag", "-l", `v${version}`]).stdout) return true;
  const result = git(
    ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/v${version}`],
    { allowFailure: true },
  );
  if (result.status === 0) return true;
  if (result.status === 2) return false;
  throw new SoftwarePublishError(
    "TAG_LOOKUP_FAILED",
    `无法确认远程 Tag v${version} 状态：${result.stderr || "未知网络错误"}`,
  );
}

function collectPublishState(repository) {
  git(["fetch", "--quiet", "origin", "main", "--tags"]);
  const branch = git(["branch", "--show-current"]).stdout;
  const dirty = Boolean(
    git(["-c", "core.quotepath=false", "status", "--short"]).stdout,
  );
  const [aheadText, behindText] = git([
    "rev-list",
    "--left-right",
    "--count",
    "main...origin/main",
  ]).stdout.split(/\s+/u);
  const ahead = Number(aheadText);
  const behind = Number(behindText);
  const release = latestRelease(repository);
  const tags = lines(git(["tag", "--list", "v*", "--sort=-v:refname"]).stdout)
    .map(strictTagVersion)
    .filter(Boolean);
  if (tags.length === 0) {
    throw new SoftwarePublishError("MISSING_TAG", "未找到任何正式 v* Git Tag。");
  }
  const latestTagVersion = tags[0];
  const versions = readVersions();
  const sourceTagExists = targetTagExists(versions.sourceVersion);
  const sourceReleaseExists = releaseExists(repository, versions.sourceVersion);
  if (versions.lockVersion !== versions.lockRootVersion) {
    throw new SoftwarePublishError(
      "LOCK_VERSION_MISMATCH",
      "package-lock.json 顶层版本与根包版本不一致。",
    );
  }
  const releaseTag = `v${release.version}`;
  const releaseAncestor = git(
    ["merge-base", "--is-ancestor", releaseTag, "HEAD"],
    { allowFailure: true },
  );
  if (releaseAncestor.status !== 0) {
    throw new SoftwarePublishError(
      "RELEASE_NOT_ANCESTOR",
      `${releaseTag} 不是当前 HEAD 的祖先，发布已停止。`,
    );
  }
  const commitsSinceRelease = lines(
    git(["log", `${releaseTag}..HEAD`, "--format=%h %s"]).stdout,
  );
  const commitsToPush = lines(
    git(["log", "origin/main..HEAD", "--format=%h %s"]).stdout,
  );
  const preliminary = createSoftwarePublishPlan({
    dirty,
    branch,
    ahead,
    behind,
    commitsToPush,
    commitsSinceRelease,
    sourceVersion: versions.sourceVersion,
    lockVersion: versions.lockVersion,
    latestReleaseVersion: release.version,
    latestTagVersion,
    sourceTagExists,
    sourceReleaseExists,
    targetTagExists: false,
    targetReleaseExists: false,
  });
  if (preliminary.kind === "none") return { ...preliminary, release };
  return {
    ...createSoftwarePublishPlan({
      dirty,
      branch,
      ahead,
      behind,
      commitsToPush,
      commitsSinceRelease,
      sourceVersion: versions.sourceVersion,
      lockVersion: versions.lockVersion,
      latestReleaseVersion: release.version,
      latestTagVersion,
      sourceTagExists,
      sourceReleaseExists,
      targetTagExists: targetTagExists(preliminary.targetVersion),
      targetReleaseExists: releaseExists(repository, preliminary.targetVersion),
    }),
    release,
  };
}

function printPlan(plan, logger) {
  logger.line("========================================");
  logger.line("VERIDIA 发布计划");
  logger.line("========================================");
  logger.line(`当前正式版本：${plan.currentVersion}`);
  logger.line(`当前源码版本：${plan.sourceVersion}`);
  if (plan.failedReservedVersion) {
    logger.line(
      `检测到 v${plan.failedReservedVersion} Tag 已存在但对应正式 Release 缺失；该失败版本号已保留。`,
    );
    logger.line(`不会覆盖、删除或移动 v${plan.failedReservedVersion} Tag。`);
  }
  logger.line(`目标版本：${plan.targetVersion}`);
  logger.line("");
  logger.line(`待 Push 提交：${plan.commitsToPush.length} 个`);
  for (const commit of plan.commitsToPush) logger.line(`- ${commit}`);
  if (plan.commitsToPush.length === 0) logger.line("- 无（提交已在 origin/main）");
  logger.line("");
  logger.line("本次版本包含的 Release 后提交：");
  for (const commit of plan.commitsSinceRelease) logger.line(`- ${commit}`);
  logger.line("");
  logger.line("工作区：干净");
  logger.line(`main ahead：${plan.ahead}`);
  logger.line(`main behind：${plan.behind}`);
  logger.line("");
  logger.line("即将执行：");
  logger.line(`1. 更新版本号至 ${plan.targetVersion}`);
  logger.line("2. 执行完整正式发布门禁并生成安装包");
  logger.line("3. 创建独立 release 版本提交");
  logger.line("4. 一次性 Push main");
  logger.line(`5. 创建并 Push v${plan.targetVersion}`);
  logger.line("6. 等待 GitHub Actions 完成");
  logger.line("7. 核验 Release、三件套和自动更新元数据");
  logger.line("");
}

export function parseGitPorcelainPaths(value) {
  const output = String(value || "");
  if (!output) return [];
  if (output.includes("\0")) {
    const records = output.split("\0");
    const paths = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) continue;
      if (record.length < 4 || record[2] !== " ") {
        throw new SoftwarePublishError(
          "INVALID_GIT_STATUS",
          `无法解析 Git porcelain 记录：${JSON.stringify(record)}`,
        );
      }
      const status = record.slice(0, 2);
      paths.push(record.slice(3));
      if (/[RC]/u.test(status)) index += 1;
    }
    return paths;
  }

  return output
    .split("\n")
    .map((line) => line.endsWith("\r") ? line.slice(0, -1) : line)
    .filter((line) => line.length > 0)
    .map((line) => {
      if (line.length < 4 || line[2] !== " ") {
        throw new SoftwarePublishError(
          "INVALID_GIT_STATUS",
          `无法解析 Git porcelain 行：${JSON.stringify(line)}`,
        );
      }
      const status = line.slice(0, 2);
      const payload = line.slice(3);
      if (!/[RC]/u.test(status)) return payload;
      const separator = payload.lastIndexOf(" -> ");
      return separator >= 0 ? payload.slice(separator + 4) : payload;
    });
}

export function assertOnlyVersionFiles(changed) {
  const allowed = new Set(["package.json", "package-lock.json"]);
  const unexpected = changed.filter((file) => !allowed.has(file));
  if (unexpected.length > 0) {
    throw new SoftwarePublishError(
      "UNEXPECTED_RELEASE_CHANGES",
      `发布验证产生了非版本文件修改：\n${unexpected.join("\n")}`,
    );
  }
}

function assertOnlyVersionFilesChanged() {
  const result = git([
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain=v1",
    "-z",
  ]);
  assertOnlyVersionFiles(parseGitPorcelainPaths(result.stdoutRaw));
}

function assertNoGoogleFontBuildDependency() {
  const tracked = lines(git(["ls-files"]).stdout).filter(
    (file) =>
      !file.startsWith("tests/") &&
      !file.startsWith("assets/fonts/") &&
      !file.startsWith("scripts/software-publish-orchestrator"),
  );
  const forbidden = /next\/font\/google|fonts\.googleapis\.com|fonts\.gstatic\.com/iu;
  const matches = [];
  for (const relative of tracked) {
    const absolute = path.join(projectRoot, relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const buffer = fs.readFileSync(absolute);
    if (buffer.includes(0)) continue;
    if (forbidden.test(buffer.toString("utf8"))) matches.push(relative);
  }
  if (matches.length > 0) {
    throw new SoftwarePublishError(
      "GOOGLE_FONTS_DEPENDENCY",
      `正式源码重新出现 Google Fonts 外网依赖：\n${matches.join("\n")}`,
    );
  }
}

function updateVersionFiles(plan, state) {
  const packagePath = path.join(projectRoot, "package.json");
  const lockPath = path.join(projectRoot, "package-lock.json");
  state.originals = new Map([
    [packagePath, fs.readFileSync(packagePath)],
    [lockPath, fs.readFileSync(lockPath)],
  ]);
  if (plan.versionChangeRequired) {
    command("npm.cmd", [
      "version",
      plan.targetVersion,
      "--no-git-tag-version",
    ], { inherit: true });
  }
  const versions = readVersions();
  if (
    versions.sourceVersion !== plan.targetVersion ||
    versions.lockVersion !== plan.targetVersion ||
    versions.lockRootVersion !== plan.targetVersion
  ) {
    throw new SoftwarePublishError(
      "VERSION_UPDATE_FAILED",
      `版本字段未统一更新为 ${plan.targetVersion}。`,
    );
  }
}

function restoreVersionFiles(state) {
  for (const [file, content] of state.originals || []) {
    fs.writeFileSync(file, content);
  }
  command("git", ["add", "package.json", "package-lock.json"], {
    allowFailure: true,
  });
}

function structuredSoftwareError(result, fallback) {
  return new SoftwarePublishError(
    "RELEASE_STAGE_FAILED",
    redactReleaseText(result?.summary || fallback.message).slice(0, 1_200),
    {
      stage: result?.stage || fallback.stage,
      classification:
        result?.classification ||
        classifyReleaseFailure(fallback.message, fallback.classification),
      command: redactReleaseText(result?.command || fallback.command || "") || undefined,
      detailLog: result?.detailLog || fallback.detailLog,
      target: redactReleaseText(result?.target || "") || undefined,
      failedItem: redactReleaseText(result?.failedItem || "") || undefined,
    },
  );
}

function readStructuredResult(file, combinedOutput = "") {
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // Fall back to the child process marker.
    }
  }
  return parseReleaseResult(combinedOutput);
}

function runReleasePreflight(plan, logger) {
  logger.line("开始 Release Preflight 与发布依赖预热（正式 FULL 之前）。");
  const result = command(
    "node",
    [
      path.join(projectRoot, "scripts", "release-preflight.mjs"),
      `--target-version=${plan.targetVersion}`,
    ],
    { allowFailure: true, timeoutMs: 120_000 },
  );
  logger.write(result.stdoutRaw);
  logger.write(result.stderrRaw);
  if (result.status !== 0) {
    const structured = parseReleaseResult(`${result.stdoutRaw}\n${result.stderrRaw}`);
    throw structuredSoftwareError(structured, {
      stage: "PREFLIGHT",
      classification: "ENVIRONMENT",
      command: `node scripts/release-preflight.mjs --target-version=${plan.targetVersion}`,
      message: `Release Preflight 失败，退出码 ${result.status ?? "未知"}`,
      detailLog: logger.logPath,
    });
  }
  logger.line("Release Preflight 与依赖预热通过，即将进入正式 FULL。");
}

function runFullValidation(plan, logger) {
  logger.line("开始完整正式发布门禁和本地安装包构建。");
  assertNoGoogleFontBuildDependency();
  git(["diff", "--check"]);
  try {
    fs.rmSync(path.join(projectRoot, ".release-work", "release-result.json"), {
      force: true,
    });
    command("node", [path.join(projectRoot, "scripts", "release.mjs"), "current"], {
      inherit: true,
      env: { VERIDIA_APP_VERSION: plan.targetVersion },
    });
  } catch (error) {
    const resultFile = path.join(
      projectRoot,
      ".release-work",
      "release-result.json",
    );
    const structured = readStructuredResult(resultFile);
    throw structuredSoftwareError(structured, {
      stage: "FULL",
      classification: "DETERMINISTIC",
      command: "node scripts/release.mjs current",
      message: error instanceof Error ? error.message : String(error),
      detailLog: path.join(projectRoot, ".release-work", "logs"),
    });
  }
  assertOnlyVersionFilesChanged();
  assertNoGoogleFontBuildDependency();
  git(["diff", "--check"]);
  try {
    command("node", [path.join(projectRoot, "scripts", "validate-software-release.mjs")], {
      inherit: true,
    });
  } catch (error) {
    throw new SoftwarePublishError(
      "INSTALLER_VERIFY_FAILED",
      error instanceof Error ? error.message : String(error),
      {
        cause: error,
        stage: "INSTALLER_VERIFY",
        classification: classifyReleaseFailure(error),
      },
    );
  }
  logger.line("完整门禁、Google Fonts 检查和本地三件套校验通过。");
}

function commitVersion(plan) {
  git(["add", "package.json", "package-lock.json"]);
  git(["diff", "--cached", "--check"]);
  const staged = git(["diff", "--cached", "--quiet"], { allowFailure: true });
  const args = ["commit"];
  if (staged.status === 0) args.push("--allow-empty");
  args.push("-m", `chore: release ${plan.targetVersion}`);
  git(args);
}

function assertMainSynchronized() {
  git(["fetch", "--quiet", "origin", "main"]);
  const [ahead, behind] = git([
    "rev-list",
    "--left-right",
    "--count",
    "main...origin/main",
  ]).stdout.split(/\s+/u);
  if (ahead !== "0" || behind !== "0") {
    throw new SoftwarePublishError(
      "MAIN_NOT_SYNCHRONIZED",
      `Push 后 main 未与 origin/main 同步（ahead ${ahead} / behind ${behind}）。`,
    );
  }
}

function assertTargetAvailable(repository, plan) {
  if (targetTagExists(plan.targetVersion)) {
    throw new SoftwarePublishError(
      "TARGET_TAG_EXISTS",
      `目标 Tag v${plan.targetVersion} 已存在，拒绝覆盖。`,
    );
  }
  if (releaseExists(repository, plan.targetVersion)) {
    throw new SoftwarePublishError(
      "TARGET_RELEASE_EXISTS",
      `GitHub Release v${plan.targetVersion} 已存在，拒绝重复发布。`,
    );
  }
}

function actionsRun(repository, tag, headSha) {
  const runs = JSON.parse(
    gh([
      "run",
      "list",
      "--repo",
      repository,
      "--workflow",
      releaseWorkflow,
      "--event",
      "push",
      "--limit",
      "20",
      "--json",
      "databaseId,headBranch,headSha,status,conclusion,url,createdAt",
    ]).stdout,
  );
  return runs.find(
    (run) => run.headBranch === tag && run.headSha === headSha,
  );
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForActions(repository, plan, logger) {
  const tag = `v${plan.targetVersion}`;
  const headSha = git(["rev-parse", "HEAD"]).stdout;
  const discoveryDeadline = Date.now() + 5 * 60_000;
  let run;
  while (!run && Date.now() < discoveryDeadline) {
    run = actionsRun(repository, tag, headSha);
    if (!run) await sleep(10_000);
  }
  if (!run) {
    throw new SoftwarePublishError(
      "ACTIONS_NOT_FOUND",
      `推送 ${tag} 后 5 分钟内未找到 GitHub Actions 运行记录。`,
    );
  }
  logger.line(`GitHub Actions 已启动，Run ID：${run.databaseId}`);
  logger.line(`Actions：${run.url}`);
  const deadline = Date.now() + 90 * 60_000;
  let previousStatus;
  while (Date.now() < deadline) {
    run = JSON.parse(
      gh([
        "run",
        "view",
        String(run.databaseId),
        "--repo",
        repository,
        "--json",
        "databaseId,status,conclusion,url,jobs",
      ]).stdout,
    );
    const status = `${run.status}/${run.conclusion || ""}`;
    if (status !== previousStatus) {
      logger.line(`GitHub Actions：${status}`);
      previousStatus = status;
    }
    if (run.status === "completed") break;
    await sleep(30_000);
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    const failed = [];
    for (const job of run.jobs || []) {
      if (job.conclusion === "failure") failed.push(`Job：${job.name}`);
      for (const step of job.steps || []) {
        if (step.conclusion === "failure") failed.push(`Step：${step.name}`);
      }
    }
    const failedLog = path.join(
      projectRoot,
      ".release-work",
      "logs",
      `github-actions-${run.databaseId}-failed.log`,
    );
    const details = gh(
      ["run", "view", String(run.databaseId), "--repo", repository, "--log-failed"],
      { allowFailure: true },
    );
    fs.writeFileSync(failedLog, `${details.stdout}\n${details.stderr}`, "utf8");
    logger.line(failed.join("\n") || "GitHub Actions 未成功完成。");
    logger.line(`失败日志：${failedLog}`);
    return { success: false, url: run.url, id: run.databaseId };
  }
  return { success: true, url: run.url, id: run.databaseId };
}

async function fetchAndHash(url, collect = false) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new SoftwarePublishError(
      "ASSET_HTTP_FAILED",
      `发布资源无法访问（HTTP ${response.status}）：${url}`,
    );
  }
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    sha256.update(buffer);
    sha512.update(buffer);
    if (collect) chunks.push(buffer);
  }
  return {
    size,
    sha256: sha256.digest("hex"),
    sha512: sha512.digest("base64"),
    buffer: collect ? Buffer.concat(chunks) : null,
  };
}

function yamlValue(text, expression) {
  return String(text.match(expression)?.[1] || "")
    .trim()
    .replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2");
}

async function verifyRemoteRelease(repository, plan, actions, logger) {
  const tag = `v${plan.targetVersion}`;
  const release = JSON.parse(
    gh([
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "tagName,name,isDraft,isPrerelease,url,assets",
    ]).stdout,
  );
  if (
    release.tagName !== tag ||
    release.name !== `VERIDIA ${plan.targetVersion}` ||
    release.isDraft ||
    release.isPrerelease
  ) {
    throw new SoftwarePublishError(
      "INVALID_REMOTE_RELEASE",
      `GitHub Release ${tag} 的标题或发布状态不正确。`,
    );
  }
  const latest = JSON.parse(
    gh([
      "release",
      "view",
      "--repo",
      repository,
      "--json",
      "tagName,name,isDraft,isPrerelease,url",
    ]).stdout,
  );
  if (latest.tagName !== tag) {
    throw new SoftwarePublishError(
      "NOT_LATEST_RELEASE",
      `GitHub Latest Release 未指向 ${tag}。`,
    );
  }
  const installerName = `VERIDIA-Setup-${plan.targetVersion}.exe`;
  const requiredAssets = [installerName, `${installerName}.blockmap`, "latest.yml"];
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  for (const name of requiredAssets) {
    if (!assets.has(name)) {
      throw new SoftwarePublishError(
        "MISSING_REMOTE_ASSET",
        `GitHub Release 缺少 ${name}。`,
      );
    }
  }
  const latestAsset = assets.get("latest.yml");
  const latestDownload = await fetchAndHash(latestAsset.url, true);
  const latestText = latestDownload.buffer.toString("utf8");
  const latestVersion = yamlValue(latestText, /^version:\s*(.+)$/mu);
  const latestPath = yamlValue(latestText, /^path:\s*(.+)$/mu);
  const latestUrl = yamlValue(latestText, /^\s*-\s*url:\s*(.+)$/mu);
  const latestSize = Number(latestText.match(/^\s+size:\s*(\d+)$/mu)?.[1]);
  const latestSha512 = yamlValue(latestText, /^\s+sha512:\s*(.+)$/mu);
  const blockmapAsset = assets.get(`${installerName}.blockmap`);
  const blockmap = await fetchAndHash(blockmapAsset.url, true);
  let blockmapValue;
  try {
    blockmapValue = JSON.parse(gunzipSync(blockmap.buffer).toString("utf8"));
  } catch (error) {
    throw new SoftwarePublishError(
      "INVALID_REMOTE_BLOCKMAP",
      `远程 blockmap 无法解析：${error instanceof Error ? error.message : error}`,
    );
  }
  if (!Array.isArray(blockmapValue.files) || blockmapValue.files.length === 0) {
    throw new SoftwarePublishError(
      "INVALID_REMOTE_BLOCKMAP",
      "远程 blockmap 不包含有效文件块。",
    );
  }
  const installerAsset = assets.get(installerName);
  logger.line("正在流式校验远程 EXE 的大小、SHA-256 和 SHA-512...");
  const installer = await fetchAndHash(installerAsset.url);
  if (
    latestVersion !== plan.targetVersion ||
    latestPath !== installerName ||
    latestUrl !== installerName ||
    latestSize !== installer.size ||
    latestSha512 !== installer.sha512 ||
    installerAsset.size !== installer.size ||
    (installerAsset.digest && installerAsset.digest !== `sha256:${installer.sha256}`)
  ) {
    throw new SoftwarePublishError(
      "REMOTE_METADATA_MISMATCH",
      "远程 latest.yml 与 EXE 的版本、文件名、大小或摘要不一致。",
    );
  }
  for (const [asset, downloaded] of [
    [latestAsset, latestDownload],
    [blockmapAsset, blockmap],
  ]) {
    if (
      asset.size !== downloaded.size ||
      (asset.digest && asset.digest !== `sha256:${downloaded.sha256}`)
    ) {
      throw new SoftwarePublishError(
        "REMOTE_ASSET_MISMATCH",
        `远程资源大小或摘要不一致：${asset.name}`,
      );
    }
  }
  return {
    url: release.url,
    actionsUrl: actions.url,
    installerName,
    installerSize: installer.size,
    installerSha256: installer.sha256,
  };
}

async function confirmPublish() {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await input.question("是否继续正式发布？ [Y/N] ")).trim();
    return /^y(?:es)?$/iu.test(answer);
  } finally {
    input.close();
  }
}

async function main() {
  const logger = createLogger();
  logger.line("========================================");
  logger.line("VERIDIA 正式发布");
  logger.line("========================================");
  logger.line("正在执行发布前检查...");
  logger.line(`开始时间：${new Date().toISOString()}`);
  logger.line(`当前目录：${projectRoot}`);
  logger.line(`模式：${dryRun ? "DRY RUN" : "正式发布"}`);
  logger.line(`日志：${logger.logPath}`);
  try {
    assertRequiredProjectRoot();
    for (const [name, friendly] of [
      ["git.exe", "Git"],
      ["gh.exe", "GitHub CLI"],
      ["npm.cmd", "npm"],
    ]) {
      assertCommandAvailable(name, friendly);
    }
    gh(["auth", "status"]);
    const repository = repositoryFromOrigin();
    gh(["api", `repos/${repository}`, "--silent"]);
    const plan = collectPublishState(repository);
    logger.line(`当前 HEAD：${git(["rev-parse", "HEAD"]).stdout}`);
    if (plan.kind === "none") {
      logger.line("当前没有待发布的新提交。");
      logger.line("没有修改版本、Push、创建 Tag 或 Release。");
      logger.line("本次未发布远程规则。");
      return;
    }
    printPlan(plan, logger);
    if (dryRun) {
      logger.line("DRY RUN 完成：未修改版本、未提交、未 Push、未创建 Tag 或 Release。");
      logger.line("本次未发布远程规则。");
      return;
    }
    if (!(await confirmPublish())) {
      logger.line("用户已取消，未修改本地或远程状态。");
      return;
    }
    const current = collectPublishState(repository);
    if (
      current.kind !== "release" ||
      current.targetVersion !== plan.targetVersion ||
      current.ahead !== plan.ahead ||
      current.behind !== plan.behind
    ) {
      throw new SoftwarePublishError(
        "PLAN_CHANGED",
        "确认后 Git 或 Release 状态发生变化，请重新运行发布脚本。",
      );
    }
    const state = { originals: null };
    const result = await executeSoftwarePublishPlan(plan, {
      dryRun: false,
      operations: {
        preflight: async () => runReleasePreflight(plan, logger),
        updateVersion: async () => updateVersionFiles(plan, state),
        validate: async () => runFullValidation(plan, logger),
        commitVersion: async () => commitVersion(plan),
        restoreVersion: async () => restoreVersionFiles(state),
        pushMain: async () => {
          logger.line("正在一次性 Push 开发提交和版本提交到 origin/main...");
          git(["push", "origin", "main"]);
        },
        assertMainSynchronized: async () => assertMainSynchronized(),
        assertTargetAvailable: async () => assertTargetAvailable(repository, plan),
        createTag: async () =>
          git(["tag", "-a", `v${plan.targetVersion}`, "-m", `VERIDIA ${plan.targetVersion}`]),
        pushTag: async () => git(["push", "origin", `v${plan.targetVersion}`]),
        waitForActions: async () => waitForActions(repository, plan, logger),
        verifyRelease: async (_value, actions) =>
          verifyRemoteRelease(repository, plan, actions, logger),
      },
    });
    assertMainSynchronized();
    const status = git(["status", "--short"]).stdout;
    if (status) {
      throw new SoftwarePublishError(
        "DIRTY_AFTER_RELEASE",
        `发布完成后工作区不干净：\n${status}`,
      );
    }
    logger.line("========================================");
    logger.line(`VERIDIA ${plan.targetVersion} 正式发布成功`);
    logger.line("========================================");
    logger.line(`软件版本：${plan.targetVersion}`);
    logger.line("Git main：ahead 0 / behind 0");
    logger.line(`Tag：v${plan.targetVersion}`);
    logger.line("GitHub Actions：SUCCESS");
    logger.line(`GitHub Release：${result.release.url}`);
    logger.line("三件套：✓ EXE / ✓ blockmap / ✓ latest.yml");
    logger.line(
      `安装包大小：${(result.release.installerSize / 1024 / 1024).toFixed(2)} MB`,
    );
    logger.line(`SHA-256：${result.release.installerSha256}`);
    logger.line("本次未执行 rules:publish，本次未发布远程规则。");
  } catch (error) {
    logger.line("");
    for (const line of formatSoftwarePublishFailure(error, logger.logPath)) {
      logger.line(line);
    }
    logger.line("不会自动 reset、rebase、覆盖 Tag 或重试发布。");
    process.exitCode = 1;
  }
}

const isCli = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) await main();
