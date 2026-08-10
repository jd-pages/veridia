import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { groupE2eFiles, selectTestScope, validateManifest } from "./test-matrix.mjs";
import { invalidateFullGateAttestation, writeFullGateAttestation } from "./full-gate-attestation.mjs";

const root = process.cwd();
const requestedMode = process.argv[2] || "fast";
if (!new Set(["fast", "regression", "full"]).has(requestedMode)) throw new Error("验证模式必须是 fast、regression 或 full");

function gitLines(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function changedFiles() {
  if (process.env.VERIDIA_TEST_CHANGED_FILES?.trim()) return process.env.VERIDIA_TEST_CHANGED_FILES.split(/[;,\r\n]+/u).map((file) => file.trim()).filter(Boolean);
  const working = [
    ...gitLines(["diff", "--name-only"]),
    ...gitLines(["diff", "--cached", "--name-only"]),
    ...gitLines(["ls-files", "--others", "--exclude-standard"]),
  ];
  if (working.length) return [...new Set(working)];
  const upstream = spawnSync("git", ["rev-parse", "--verify", "origin/main"], { cwd: root, stdio: "ignore", windowsHide: true });
  return upstream.status === 0 ? gitLines(["diff", "--name-only", "origin/main...HEAD"]) : [];
}

function command(name, executable, args, options = {}) {
  const started = Date.now();
  process.stdout.write(`\n[${name}] ${executable} ${args.join(" ")}\n`);
  const usesWindowsCommandProcessor = process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(executable);
  const quote = (value) => /[\s"&|<>^]/u.test(String(value))
    ? `"${String(value).replaceAll('"', '""')}"`
    : String(value);
  const actualExecutable = usesWindowsCommandProcessor ? process.env.ComSpec || "cmd.exe" : executable;
  const actualArgs = usesWindowsCommandProcessor
    ? ["/d", "/s", "/c", ["call", executable, ...args].map(quote).join(" ")]
    : args;
  const result = spawnSync(actualExecutable, actualArgs, {
    cwd: root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 200 * 1024 * 1024,
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.error) process.stderr.write(`[${name}] 启动失败: ${result.error.message}\n`);
  const durationSeconds = Number(((Date.now() - started) / 1000).toFixed(2));
  process.stdout.write(`[${name}] ${result.status === 0 ? "PASSED" : "FAILED"} (${durationSeconds}s)\n`);
  return { name, passed: !result.error && result.status === 0, status: result.status, output: `${result.stdout || ""}\n${result.stderr || ""}\n${result.error?.message || ""}`, durationSeconds };
}

function npm(name, args, options) {
  return command(name, process.platform === "win32" ? "npm.cmd" : "npm", args, options);
}

function passedTestCount(output) {
  const plain = output.replace(/\u001b\[[0-9;]*m/gu, "");
  return Number(plain.match(/Tests\s+(\d+) passed/u)?.[1] || 0);
}

const failures = [];
const timings = [];
const record = (result) => {
  timings.push({ name: result.name, seconds: result.durationSeconds, passed: result.passed });
  if (!result.passed) failures.push(result.name);
  return result;
};

const formalFiles = validateManifest(root);
const changes = changedFiles();
let mode = requestedMode;
let selection = requestedMode === "full" ? null : selectTestScope(changes, requestedMode);
if (selection?.minimumMode === "regression" && mode === "fast") {
  mode = "regression";
  selection = selectTestScope(changes, "regression");
}
const selectedFiles = mode === "full" ? formalFiles : selection.e2eFiles;
process.stdout.write([
  "========================================",
  `VERIDIA ${mode.toUpperCase()} 验证门禁`,
  "========================================",
  `检测到的变更：${changes.length ? changes.join(", ") : "无（保守回退）"}`,
  `选择分类：${mode === "full" ? "全部正式分类" : selection.categories.join(", ")}`,
  `E2E 文件（${selectedFiles.length}/${formalFiles.length}）：${selectedFiles.join(", ")}`,
  ...(selection ? selection.reasons.map((reason) => `选择原因：${reason}`) : ["选择原因：FULL 明确执行全部正式 E2E；不使用变更选择器"]),
  mode === "full" ? "执行策略：完整报告，单个业务失败不阻断其余独立门禁" : `执行策略：${mode === "fast" ? "fail-fast" : "受影响模块全量 + 跨模块回归"}`,
  "",
].join("\n"));

if (mode === "full") invalidateFullGateAttestation(root);

record(npm("Prisma Client", ["run", "db:generate"]));
record(npm("Prisma Client assert", ["run", "prisma:assert"]));
record(npm("Lint", ["run", "lint"]));
record(npm("Typecheck", ["run", "typecheck"]));

let unitTotal = 0;
let unitCommandName = "All unit tests";
if (mode === "fast") {
  const related = changes.filter((file) => /\.(?:ts|tsx|js|mjs|json)$/u.test(file));
  unitCommandName = related.length ? "Affected unit tests" : "All unit tests (conservative fallback)";
  const unit = record(related.length
    ? npm(unitCommandName, ["exec", "--", "vitest", "related", ...related, "--run", "--passWithNoTests"])
    : npm(unitCommandName, ["test"]));
  unitTotal = passedTestCount(unit.output);
} else {
  const unit = record(npm(unitCommandName, ["test"]));
  unitTotal = passedTestCount(unit.output);
}

let e2eTotal = 0;
let e2ePassed = 0;
const groups = groupE2eFiles(selectedFiles);
for (const group of groups) {
  const result = record(command(`E2E ${group.name}`, process.execPath, [
    path.join(root, "scripts", "testing", "run-e2e.mjs"),
    `--group=${group.name}`,
    `--workers=${group.workers}`,
    ...(mode === "fast" ? ["--fail-fast"] : []),
    ...group.files,
  ]));
  const marker = result.output.match(/VERIDIA_E2E_RESULT=(\{[^\r\n]+\})/u);
  if (marker) {
    const summary = JSON.parse(marker[1]);
    e2eTotal += summary.total;
    e2ePassed += summary.passed;
  }
  if (!result.passed && mode === "fast") break;
}

if (mode !== "fast") record(npm("Production build", ["run", "build"]));
if (mode === "full") {
  record(command("Database compatibility", process.execPath, [path.join(root, "scripts", "testing", "verify-databases.mjs")]));
  record(npm("Desktop health", ["run", "test:desktop-health"]));
  record(npm("Sensitive scan", ["run", "scan:sensitive"]));
}
record(command("git diff --check", "git", ["diff", "--check"]));
record(command("git diff --cached --check", "git", ["diff", "--cached", "--check"]));

const summary = {
  mode: mode.toUpperCase(),
  requestedMode: requestedMode.toUpperCase(),
  passed: failures.length === 0,
  failures,
  e2eTotal,
  e2ePassed,
  unitTests: { passed: failures.includes(unitCommandName) ? 0 : unitTotal, total: unitTotal },
  productionBuild: mode === "fast" ? "NOT_REQUIRED" : failures.includes("Production build") ? "FAILED" : "PASSED",
  sqliteFreshMigration: mode === "full" && !failures.includes("Database compatibility") ? "PASSED" : mode === "full" ? "FAILED" : "NOT_REQUIRED",
  sqliteLegacyUpgrade: mode === "full" && !failures.includes("Database compatibility") ? "PASSED" : mode === "full" ? "FAILED" : "NOT_REQUIRED",
  postgresValidate: mode === "full" && !failures.includes("Database compatibility") ? "PASSED" : mode === "full" ? "FAILED" : "NOT_REQUIRED",
  sensitiveScan: mode === "full" && !failures.includes("Sensitive scan") ? "PASSED" : mode === "full" ? "FAILED" : "NOT_REQUIRED",
  gitDiffCheck: !failures.some((name) => name.startsWith("git diff")) ? "PASSED" : "FAILED",
  lint: failures.includes("Lint") ? "FAILED" : "PASSED",
  typecheck: failures.includes("Typecheck") ? "FAILED" : "PASSED",
  timings,
};

if (mode === "full" && summary.passed && process.env.VERIDIA_DISABLE_ATTESTATION_WRITE !== "true") {
  try {
    const attestation = writeFullGateAttestation(summary, root);
    process.stdout.write(`FULL 验收凭证已生成：${path.relative(root, path.join(root, ".release-work", "verification", "full-gate-attestation.json"))}\n绑定 HEAD：${attestation.gitHead}\n`);
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.message : String(error)}。本次门禁结果仍有效，但不可供本地打包复用。\n`);
  }
}

fs.mkdirSync(path.join(root, ".playwright"), { recursive: true });
fs.writeFileSync(path.join(root, ".playwright", `verification-${mode}.json`), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
process.stdout.write(`\nVERIDIA_VERIFY_RESULT=${JSON.stringify(summary)}\n`);
if (!summary.passed) process.exitCode = 1;
