import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { resolveFormalDataRoot } from "./formal-data-root.mjs";
import {
  withLocalPackageFileRestore,
  writeLocalPackageAcceptance,
} from "./testing/local-package-worktree.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const requestedPreviewMode = process.argv
  .find((value) => value.startsWith("--mode="))
  ?.slice("--mode=".length);
const requestedPreviewPort = Number(
  process.argv
    .find((value) => value.startsWith("--port="))
    ?.slice("--port=".length) || 0,
);
const acceptancePath = path.join(root, ".release-work", "acceptance.json");

function packageInfo() {
  const packagePath = path.join(root, "package.json");
  if (!fs.existsSync(packagePath)) {
    throw new Error("当前目录不是 VERIDIA 项目目录：缺少 package.json。");
  }
  const value = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  if (value.name !== "veridia" || value.productName !== "VERIDIA") {
    throw new Error("当前目录不是有效的 VERIDIA 项目目录。");
  }
  return value;
}

function ensureLocalPrerequisites() {
  packageInfo();
  if (!process.version) throw new Error("未检测到 Node.js。");
  if (!fs.existsSync(path.join(root, "node_modules"))) {
    throw new Error("缺少 node_modules，请先在项目目录运行 npm.cmd ci。");
  }
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: options.capture ? "pipe" : "inherit",
    maxBuffer: 100 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = options.capture
      ? `${result.stdout || ""}${result.stderr || ""}`.trim()
      : "";
    throw new Error(
      `${path.basename(executable)} 执行失败，退出码 ${result.status ?? "未知"}${
        output ? `：${output}` : ""
      }`,
    );
  }
  return options.capture ? result.stdout.trim() : "";
}

function git(args, allowFailure = false) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr || `git ${args.join(" ")} 执行失败`);
  }
  return {
    status: result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function assertSoftwarePublishGitState() {
  const branch = git(["branch", "--show-current"]).stdout;
  if (branch !== "main") {
    throw new Error("软件正式发布只能从 main 分支执行。");
  }
  const status = git([
    "-c",
    "core.quotepath=false",
    "status",
    "--short",
  ]).stdout;
  if (status) {
    throw new Error(
      `软件发布要求工作区干净，请先提交或处理以下文件：\n${status}`,
    );
  }
  git(["fetch", "--quiet", "origin", "main"]);
  const [ahead, behind] = git([
    "rev-list",
    "--left-right",
    "--count",
    "main...origin/main",
  ]).stdout.split(/\s+/u);
  if (ahead !== "0" || behind !== "0") {
    throw new Error(
      `main 与 origin/main 未同步（ahead ${ahead || "?"} / behind ${behind || "?"}），发布已停止。`,
    );
  }
}

function sourceFingerprint() {
  const files = git([
    "-c",
    "core.quotepath=false",
    "ls-files",
    "-co",
    "--exclude-standard",
  ]).stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  for (const relative of files) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute) || fs.statSync(absolute).isDirectory()) continue;
    hash.update(relative.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(fs.readFileSync(absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function remoteTagExists(version) {
  if (git(["tag", "-l", `v${version}`]).stdout === `v${version}`) return true;
  const result = git(
    ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/v${version}`],
    true,
  );
  if (result.status === 0) return true;
  if (result.status === 2) return false;
  throw new Error(
    `无法安全确认远程 v${version} Tag 状态，请检查网络或 GitHub 授权后重试。`,
  );
}

let input;

async function ask(prompt) {
  input ??= readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return (await input.question(prompt)).trim();
}

function addressFree(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

async function portFree(port) {
  if (await requestHealth(port)) return false;
  if (!(await addressFree(port, "127.0.0.1"))) return false;
  return addressFree(port, "::");
}

function requestHealthDetails(port) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/health",
        timeout: 1_500,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve({
              healthy: response.statusCode === 200 && body?.ok === true,
              instanceId: body?.instanceId || null,
            });
          } catch {
            resolve({ healthy: false, instanceId: null });
          }
        });
      },
    );
    request.once("timeout", () => request.destroy());
    request.once("error", () =>
      resolve({ healthy: false, instanceId: null }),
    );
  });
}

async function requestHealth(port) {
  return (await requestHealthDetails(port)).healthy;
}

async function waitForHealth(port, instanceId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await requestHealthDetails(port);
    if (
      health.healthy &&
      (!instanceId || health.instanceId === instanceId)
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

function windowsFileUrl(databasePath) {
  return `file:${path.resolve(databasePath).replaceAll("\\", "/")}`;
}

function previewLocations(mode) {
  const dataRoot =
    mode === "formal"
      ? resolveFormalDataRoot()
      : mode === "setup"
        ? path.join(
            process.env.VERIDIA_SETUP_PREVIEW_ROOT || "E:\\v-preview-setup",
            new Date().toISOString().replace(/[:.]/gu, "-"),
          )
        : process.env.VERIDIA_PREVIEW_DATA_DIR || "E:\\v-preview";
  return {
    dataRoot: path.resolve(dataRoot),
    databasePath: path.resolve(dataRoot, "data", "veridia.db"),
  };
}

function previewEnvironment(mode, locations) {
  const localPreview = mode !== "setup";
  return {
    ...process.env,
    NODE_ENV: "development",
    DATABASE_URL: windowsFileUrl(locations.databasePath),
    VERIDIA_DATA_DIR: locations.dataRoot,
    VERIDIA_DATA_LOCATION_CONFIRMED: "true",
    XHS_PROFILE_PATH: path.join(
      locations.dataRoot,
      "sessions",
      "xiaohongshu-profile",
    ),
    AUTOMATION_EVIDENCE_PATH: path.join(locations.dataRoot, "logs", "evidence"),
    VERIDIA_LOCAL_PREVIEW: localPreview ? "1" : "0",
    VERIDIA_RUNTIME_KIND: localPreview ? "source-preview" : "source-setup-test",
    VERIDIA_PREVIEW_DATA_MODE: mode === "safe" ? "isolated" : "formal",
    VERIDIA_DESKTOP: "false",
    VERIDIA_PACKAGED: "false",
  };
}

function runPreviewCommand(executable, args, environment, capture = false) {
  return spawnSync(executable, args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
    stdio: capture ? "pipe" : "inherit",
    maxBuffer: 50 * 1024 * 1024,
  });
}

function backupFormalDatabase(locations) {
  if (!fs.existsSync(locations.databasePath)) return null;
  const backupRoot = path.join(locations.dataRoot, "backups");
  fs.mkdirSync(backupRoot, { recursive: true });
  const backupPath = path.join(
    backupRoot,
    `before-source-preview-${new Date()
      .toISOString()
      .replace(/[:.]/gu, "-")}.db`,
  );
  fs.copyFileSync(locations.databasePath, backupPath);
  return backupPath;
}

function resetIncompatibleIsolatedPreview(locations) {
  if (!fs.existsSync(locations.databasePath)) return null;
  const backupRoot = path.join(locations.dataRoot, "backups");
  fs.mkdirSync(backupRoot, { recursive: true });
  const backupPath = path.join(
    backupRoot,
    `incompatible-preview-${new Date()
      .toISOString()
      .replace(/[:.]/gu, "-")}.db`,
  );
  fs.renameSync(locations.databasePath, backupPath);
  return backupPath;
}

function deployPreviewDatabase(mode, locations, environment) {
  for (const relative of ["data", "backups", "logs", "sessions"]) {
    fs.mkdirSync(path.join(locations.dataRoot, relative), { recursive: true });
  }
  const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js");
  const ensureArgs = [tsxCli, path.join(root, "scripts", "ensure-sqlite-db.ts")];
  const migrateArgs = [
    prismaCli,
    "migrate",
    "deploy",
    "--schema",
    path.join(root, "prisma", "schema.prisma"),
  ];

  if (mode === "formal") {
    const backupPath = backupFormalDatabase(locations);
    if (backupPath) {
      process.stdout.write(`迁移前数据库备份：${backupPath}\n`);
    }
  }

  for (const [executable, args] of [
    [process.execPath, ensureArgs],
    [process.execPath, migrateArgs],
  ]) {
    const result = runPreviewCommand(executable, args, environment);
    if (result.status !== 0) {
      throw new Error(
        `数据库迁移失败，退出码 ${result.status ?? "未知"}。正式数据没有被清空。`,
      );
    }
  }

  if (mode === "setup") return;
  const prepare = () =>
    runPreviewCommand(
      process.execPath,
      [tsxCli, path.join(root, "scripts", "prepare-local-preview.ts")],
      environment,
    );
  let result = prepare();
  if (result.status === 42 && mode === "safe") {
    const backupPath = resetIncompatibleIsolatedPreview(locations);
    process.stdout.write(
      `旧预览数据库结构不兼容，已保留到 ${backupPath}，正在创建新的预览数据库。\n`,
    );
    for (const [executable, args] of [
      [process.execPath, ensureArgs],
      [process.execPath, migrateArgs],
    ]) {
      const retry = runPreviewCommand(executable, args, environment);
      if (retry.status !== 0) {
        throw new Error("重建预览数据库时迁移失败。");
      }
    }
    result = prepare();
  }
  if (result.status !== 0) {
    throw new Error(
      mode === "formal"
        ? "正式数据目录结构与当前代码不匹配，预览已停止。请查看上方迁移提示，脚本没有清空正式数据库。"
        : "本地预览账号或基础规则初始化失败。",
    );
  }
}

async function choosePreviewMode() {
  if (["safe", "formal", "setup"].includes(requestedPreviewMode)) {
    return requestedPreviewMode;
  }
  process.stdout.write(
    [
      "",
      "请选择本地预览方式：",
      "1. 安全预览（推荐）：使用 E:\\v-preview，不需要激活",
      `2. 正式数据预览：使用当前桌面数据目录 ${resolveFormalDataRoot()}，需要谨慎`,
      "3. 首次启动流程测试：测试 setup / 激活流程",
      "",
    ].join("\n"),
  );
  const choice = dryRun ? "1" : await ask("请输入 1、2 或 3（直接回车默认 1）：");
  return { "": "safe", 1: "safe", 2: "formal", 3: "setup" }[choice] || null;
}

async function choosePreviewPort() {
  if (requestedPreviewPort) {
    if (
      !Number.isInteger(requestedPreviewPort) ||
      requestedPreviewPort < 1024 ||
      requestedPreviewPort > 65535
    ) {
      throw new Error("指定的预览端口无效。");
    }
    if (!(await portFree(requestedPreviewPort))) {
      throw new Error(
        `指定端口 ${requestedPreviewPort} 已被占用，脚本不会结束或误杀该进程。`,
      );
    }
    return requestedPreviewPort;
  }
  let port = 3100;
  if (!(await portFree(port))) {
    const veridia = await requestHealth(port);
    process.stdout.write(
      veridia
        ? "端口 3100 已由正在运行的 VERIDIA 服务占用。\n"
        : "端口 3100 已被其他程序占用，脚本不会结束或误杀该进程。\n",
    );
    if (dryRun) {
      process.stdout.write("Dry-run：计划改用 3101，但不会启动服务。\n");
      port = 3101;
    } else {
      const answer = await ask("是否改用 3101 启动本地预览？输入 Y 继续：");
      if (answer.toUpperCase() !== "Y") return null;
      port = 3101;
    }
  }
  if (!(await portFree(port))) {
    throw new Error(
      `端口 ${port} 也已被占用。脚本不会误杀进程，请先确认占用程序后重试。`,
    );
  }
  return port;
}

async function preview() {
  ensureLocalPrerequisites();
  const info = packageInfo();
  const mode = await choosePreviewMode();
  if (!mode) {
    process.stdout.write("选择无效，已安全退出。\n");
    return;
  }
  const locations = previewLocations(mode);
  const environment = previewEnvironment(mode, locations);
  const port = await choosePreviewPort();
  if (!port) {
    process.stdout.write("已取消，本次没有启动或停止任何服务。\n");
    return;
  }
  const targetPath = mode === "setup" ? "/setup" : "/dashboard";
  const url = `http://localhost:${port}${targetPath}`;
  environment.VERIDIA_NEXT_DIST_DIR = `.next-preview-${port}`;

  if (dryRun) {
    process.stdout.write(
      [
        "本地预览 dry-run 通过。",
        `计划预览地址：${url}`,
        `当前版本：${info.version}`,
        `当前数据目录：${locations.dataRoot}`,
        `模式：${
          mode === "safe"
            ? "安全本地预览（免激活）"
            : mode === "formal"
              ? "正式数据本地预览（免激活）"
              : "首次启动流程测试（正式激活逻辑）"
        }`,
        "没有迁移、打包、发布、创建 Tag、创建 Release 或上传文件。",
        "",
      ].join("\n"),
    );
    return;
  }

  if (mode === "formal") {
    process.stdout.write(
      [
        "",
        `警告：当前将使用正式数据目录 ${locations.dataRoot} 预览。`,
        "脚本不会删除、清空或重置账号，但会检查并执行当前代码需要的 Prisma 迁移。",
        "迁移前会自动备份现有数据库。",
        "",
      ].join("\n"),
    );
    const confirmation = await ask("输入“我确认使用正式数据”后继续：");
    if (confirmation !== "我确认使用正式数据") {
      process.stdout.write("确认文字不匹配，已安全退出。\n");
      return;
    }
  }

  deployPreviewDatabase(mode, locations, environment);

  const workDirectory = path.join(root, ".preview-work");
  fs.mkdirSync(workDirectory, { recursive: true });
  const output = fs.openSync(path.join(workDirectory, "server.log"), "a");
  const error = fs.openSync(path.join(workDirectory, "server-error.log"), "a");
  const instanceId = `source-preview-${Date.now()}-${process.pid}`;
  environment.VERIDIA_DESKTOP_INSTANCE_ID = instanceId;
  const executable = process.execPath;
  const args = [
    path.join(root, "node_modules", "next", "dist", "bin", "next"),
    "dev",
    "-p",
    String(port),
  ];
  const child = spawn(executable, args, {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", output, error],
    env: environment,
  });
  child.unref();
  fs.writeFileSync(
    path.join(workDirectory, "server.json"),
    JSON.stringify(
      {
        pid: child.pid,
        port,
        mode,
        dataRoot: locations.dataRoot,
        instanceId,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
  if (!(await waitForHealth(port, instanceId))) {
    throw new Error(
      `本地预览未在 60 秒内就绪，请查看 ${path.join(
        workDirectory,
        "server-error.log",
      )}`,
    );
  }
  spawn("cmd.exe", ["/d", "/c", "start", "", url], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  }).unref();
  process.stdout.write(
    [
      "",
      "VERIDIA 本地预览已启动。",
      `本地预览地址：${url}`,
      `当前版本：${info.version}`,
      `当前数据目录：${locations.dataRoot}`,
      `当前模式：${
        mode === "setup"
          ? "首次启动流程测试（保留正式激活逻辑）"
          : "本地预览模式，不需要激活"
      }`,
      mode === "setup"
        ? "浏览器将打开首次启动设置页。"
        : "预览管理员：Terry Preview（ADMIN），浏览器将直接打开工作台。",
      "本地预览模式不会打包、发布、创建 Tag 或上传文件。",
      `预览日志：${path.join(workDirectory, "server.log")}`,
      "",
    ].join("\n"),
  );
}

async function localPackage() {
  ensureLocalPrerequisites();
  const info = packageInfo();
  let releaseMode = "current";
  if (remoteTagExists(info.version)) {
    process.stdout.write(
      `当前版本 v${info.version} 已存在正式 Tag，不能用本地验收包覆盖。\n`,
    );
    const choice = dryRun
      ? "1"
      : await ask(
          "请选择下一个本地验收版本：1=patch，2=minor，3=major，其他输入取消：",
        );
    releaseMode = { 1: "patch", 2: "minor", 3: "major" }[choice] || "";
    if (!releaseMode) {
      process.stdout.write("已取消，没有修改版本或生成安装包。\n");
      return;
    }
  }
  if (dryRun) {
    process.stdout.write(
      [
        "本地打包验收 dry-run 通过。",
        `当前版本：${info.version}`,
        `计划模式：${releaseMode}`,
        "将先升级本地候选版本，再运行 Prisma Client 检查、TypeScript、ESLint、全部单元测试、桌面健康检查、E2E、Next.js 构建、敏感扫描和 Windows 打包。",
        "不会创建 Tag、Release，不会上传安装包，也不会发布规则。",
        "",
      ].join("\n"),
    );
    return;
  }
  const version = await withLocalPackageFileRestore(root, () => {
    run("node", [path.join(root, "scripts", "release.mjs"), releaseMode], {
      env: { VERIDIA_ALLOW_FULL_ATTESTATION_REUSE: "true" },
    });
    run("node", [path.join(root, "scripts", "finalize-release.mjs"), "summary"]);
    return packageInfo().version;
  });
  writeLocalPackageAcceptance({
    acceptancePath,
    worktreeStatus: git(["status", "--porcelain"]).stdout,
    acceptance: {
      version,
      acceptedAt: new Date().toISOString(),
      sourceFingerprint: sourceFingerprint(),
      checks: [
        "Prisma Client",
        "TypeScript",
        "ESLint",
        "单元测试",
        "桌面健康检查",
        "E2E",
        "Next.js生产构建",
        "敏感信息扫描",
        "Windows安装包构建",
      ],
    },
  });
  process.stdout.write(
    [
      "",
      `本地安装包路径：${path.join(root, "release", version)}`,
      `当前版本：${version}`,
      "状态：仅本地安装包。",
      "当前还没有发布到 GitHub Release，也没有创建 Tag 或上传文件。",
      "请安装并完成升级、登录、规则同步、审核和导出验收。",
      "",
    ].join("\n"),
  );
}

function readAcceptance() {
  if (!fs.existsSync(acceptancePath)) {
    throw new Error("未找到本地打包验收记录，请先运行“本地打包验收.bat”。");
  }
  return JSON.parse(fs.readFileSync(acceptancePath, "utf8"));
}

async function publish() {
  ensureLocalPrerequisites();
  const info = packageInfo();
  if (!dryRun) assertSoftwarePublishGitState();
  const acceptance = dryRun
    ? {
        version: info.version,
        acceptedAt: "dry-run（未执行真实验收）",
        sourceFingerprint: sourceFingerprint(),
      }
    : readAcceptance();
  if (acceptance.version !== info.version) {
    throw new Error("本地验收版本与当前版本不一致，请重新运行本地打包验收。");
  }
  if (acceptance.sourceFingerprint !== sourceFingerprint()) {
    throw new Error("本地验收后源码发生了变化，请重新运行本地打包验收。");
  }
  run("node", [path.join(root, "scripts", "sensitive-scan.mjs")]);
  if (
    !dryRun ||
    fs.existsSync(
      path.join(
        root,
        "release",
        info.version,
        `VERIDIA-Setup-${info.version}.exe`,
      ),
    )
  ) {
    run("node", [path.join(root, "scripts", "finalize-release.mjs"), "summary"]);
  }

  const branch = git(["branch", "--show-current"]).stdout;
  const commit = git(["rev-parse", "--short=12", "HEAD"]).stdout;
  const status = "工作区干净，main 与 origin/main 已同步";
  process.stdout.write(
    [
      "",
      "请确认已经完成以下步骤：",
      "1. 本地预览测试通过；",
      "2. 本地打包验收通过；",
      "3. 安装包能正常安装和升级；",
      "4. 登录、规则同步、审核任务、审核结果、导出功能均已验收。",
      "",
      `当前版本：${info.version}`,
      `当前分支：${branch}`,
      `最近 commit：${commit}`,
      `本地测试：已于 ${acceptance.acceptedAt} 完成`,
      `将创建 Tag：v${info.version}`,
      `将创建 GitHub Release：VERIDIA v${info.version}`,
      "将上传文件：",
      `- VERIDIA-Setup-${info.version}.exe`,
      `- VERIDIA-Setup-${info.version}.exe.blockmap`,
      "- latest.yml",
      "本次软件更新包含自动更新所需文件：安装包 exe、blockmap、latest.yml。",
      "客户端将通过 latest.yml 检测版本，并优先使用 blockmap 进行差分更新。",
      "git status：",
      status,
      "",
    ].join("\n"),
  );
  if (dryRun) {
    const suppliedConfirmation = process.argv
      .find((value) => value.startsWith("--confirmation="))
      ?.slice("--confirmation=".length);
    process.stdout.write(
      [
        "正式发布 dry-run 通过，没有创建 Tag、Release 或上传文件。",
        suppliedConfirmation === undefined
          ? "未提供模拟确认文字。"
          : suppliedConfirmation === "我确认发布"
            ? "模拟确认文字匹配：真实模式将继续发布。"
            : "模拟确认文字不匹配：真实模式将安全退出。",
        "",
      ].join("\n"),
    );
    return;
  }
  const confirmation = await ask(
    "只有准确输入“我确认发布”才会继续：",
  );
  if (confirmation !== "我确认发布") {
    process.stdout.write("确认文字不匹配，已安全退出，没有执行发布。\n");
    return;
  }
  const pending = spawnSync(
    "node",
    [path.join(root, "scripts", "finalize-release.mjs"), "pending"],
    {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (pending.status === 2) {
    throw new Error(`v${info.version} 已存在 GitHub Release，拒绝重复发布。`);
  }
  if (pending.status !== 0) {
    throw new Error("GitHub 发布前检查失败，没有创建或上传任何内容。");
  }
  run("node", [
    path.join(root, "scripts", "finalize-release.mjs"),
    "trigger-actions",
  ]);
  process.stdout.write(
    [
      "",
      `发布版本号：${info.version}`,
      `Tag：v${info.version}`,
      `已推送 Tag：v${info.version}`,
      "GitHub Actions：已触发 Windows 云端构建与发布流程",
      `预期安装包：VERIDIA-Setup-${info.version}.exe`,
      "预期更新文件：latest.yml、安装包 blockmap",
      "下一步：等待 Actions 通过，再在旧版客户端“系统设置 → 检查更新”验证自动更新。",
      "",
    ].join("\n"),
  );
}

try {
  if (command === "preview") await preview();
  else if (command === "package") await localPackage();
  else if (command === "publish") await publish();
  else throw new Error("命令必须为 preview、package 或 publish。");
} catch (error) {
  process.stderr.write(
    `\n操作失败：${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  input?.close();
}
