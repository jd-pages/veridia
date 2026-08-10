import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  printValidation as printFullGateAttestationValidation,
  validateFullGateAttestation,
} from "./testing/full-gate-attestation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bump = process.argv[2];
if (!["current", "patch", "minor", "major"].includes(bump)) {
  throw new Error("本地打包模式必须为 current、patch、minor 或 major");
}

const packagePath = path.join(root, "package.json");
const lockPath = path.join(root, "package-lock.json");
const changelogPath = path.join(root, "CHANGELOG.md");
const originals = new Map(
  [packagePath, lockPath, changelogPath].map((file) => [
    file,
    fs.existsSync(file) ? fs.readFileSync(file) : null,
  ]),
);
const workRoot = path.join(root, ".release-work");
const logsRoot = path.join(workRoot, "logs");
fs.mkdirSync(logsRoot, { recursive: true });

function quoteWindowsCommandArgument(value) {
  const text = String(value);
  if (!text) return '""';
  return /[\s"&|<>^]/u.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

function run(label, command, args, extraEnv = {}) {
  process.stdout.write(`\n[VERIDIA 发布] ${label}\n`);
  const usesWindowsCommandProcessor =
    process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(command);
  const executable = usesWindowsCommandProcessor
    ? process.env.ComSpec || "cmd.exe"
    : command;
  const executableArgs = usesWindowsCommandProcessor
    ? [
        "/d",
        "/s",
        "/c",
        ["call", command, ...args]
          .map(quoteWindowsCommandArgument)
          .join(" "),
      ]
    : args;
  const result = spawnSync(executable, executableArgs, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 100 * 1024 * 1024,
  });
  const launchError = result.error
    ? `\n[进程启动失败] ${result.error.code || result.error.name}: ${
        result.error.message
      }\n`
    : "";
  const output = `${result.stdout || ""}${result.stderr || ""}${launchError}`;
  fs.writeFileSync(
    path.join(logsRoot, `${label.replace(/[^\p{L}\p{N}-]+/gu, "-")}.log`),
    output,
    "utf8",
  );
  process.stdout.write(output);
  if (result.error) {
    throw new Error(
      `${label}无法启动：${result.error.code || result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${label}失败，退出码 ${
        result.status === null ? "不可用" : result.status
      }${result.signal ? `，信号 ${result.signal}` : ""}`,
    );
  }
}

function restoreVersionFiles() {
  for (const [file, content] of originals) {
    if (content === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, content);
  }
}

function updateChangelog(version) {
  const date = new Date().toISOString().slice(0, 10);
  const notes = (
    process.env.VERIDIA_RELEASE_NOTES ||
    "通过自动检查、单元测试、端到端测试和 Windows 桌面构建验证。"
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `- ${line.replace(/^[-*]\s*/, "")}`)
    .join("\n");
  const previous = originals.get(changelogPath)?.toString("utf8") || "";
  const body = previous.startsWith("# VERIDIA 更新日志")
    ? previous.replace(/^# VERIDIA 更新日志\s*/u, "")
    : previous;
  fs.writeFileSync(
    changelogPath,
    `# VERIDIA 更新日志\n\n## ${version} - ${date}\n\n${notes}\n\n${body}`.trimEnd() +
      "\n",
    "utf8",
  );
}

function repositoryUpdateUrl() {
  if (process.env.VERIDIA_UPDATE_URL) return process.env.VERIDIA_UPDATE_URL;
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  const match = (result.stdout || "").trim().match(
    /github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i,
  );
  return match
    ? `https://github.com/${match[1]}/releases/latest/download`
    : "https://example.invalid/veridia/releases/latest/download";
}

try {
  const allowLocalAttestationReuse =
    process.env.VERIDIA_ALLOW_FULL_ATTESTATION_REUSE === "true";
  let reuseFullGate = false;
  if (allowLocalAttestationReuse) {
    let validation = validateFullGateAttestation(root);
    printFullGateAttestationValidation(validation);
    if (!validation.valid) {
      run("FULL验收凭证失效，重新执行完整门禁", "npm.cmd", [
        "run",
        "verify:full",
      ]);
      validation = validateFullGateAttestation(root);
      if (!validation.valid) {
        throw new Error(
          `FULL 门禁执行后仍未生成有效凭证：${validation.reasons.join("；")}`,
        );
      }
    }
    reuseFullGate = true;
    process.stdout.write(
      "本次本地安装包验收复用当前 HEAD 的有效 FULL 门禁结果，跳过重复完整 E2E。\n",
    );
  }
  if (bump !== "current") {
    run("升级版本号", "npm.cmd", [
      "version",
      bump,
      "--no-git-tag-version",
    ]);
  }
  const version = JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
  if (bump !== "current") updateChangelog(version);

  if (!reuseFullGate) {
    run("正式FULL门禁", "npm.cmd", ["run", "verify:full"], {
      VERIDIA_DISABLE_ATTESTATION_WRITE: "true",
    });
  }
  run("敏感信息扫描", "node", [
    path.join(root, "scripts", "sensitive-scan.mjs"),
  ]);

  run("正式Next构建", "npm.cmd", ["run", "build"], {
    VERIDIA_APP_VERSION: version,
    VERIDIA_BUILD_DATE: new Date().toISOString(),
  });
  run("准备桌面资源", "npm.cmd", ["run", "desktop:prepare"]);
  run("准备并检查 Electron 运行文件", "npm.cmd", ["run", "electron:ensure"]);
  run(
    "构建Windows安装包",
    "node",
    [
      path.join(root, "node_modules", "electron-builder", "out", "cli", "cli.js"),
      "--win",
      "nsis",
      "--publish",
      "never",
    ],
    {
      VERIDIA_UPDATE_URL: repositoryUpdateUrl(),
    },
  );

  const destination = path.join(root, "release", version);
  fs.mkdirSync(destination, { recursive: true });
  const installerName = `VERIDIA-Setup-${version}.exe`;
  for (const name of [
    installerName,
    `${installerName}.blockmap`,
    "latest.yml",
  ]) {
    const source = path.join(root, "dist-installer", name);
    if (!fs.existsSync(source)) {
      throw new Error(`Windows 安装产物缺失：${source}`);
    }
    fs.copyFileSync(source, path.join(destination, name));
  }
  fs.cpSync(logsRoot, path.join(destination, "logs"), { recursive: true });
  fs.copyFileSync(changelogPath, path.join(destination, "CHANGELOG.md"));
  process.stdout.write(
    `\nVERIDIA ${version} 已完成本地打包：${destination}\n` +
      "当前仅生成本地安装包，没有创建 Tag、GitHub Release 或上传文件。\n",
  );
} catch (error) {
  restoreVersionFiles();
  process.stderr.write(
    `\n发布已停止，正式版本号未保留：${
      error instanceof Error ? error.message : String(error)
    }\n错误日志：${logsRoot}\n`,
  );
  process.exitCode = 1;
}
