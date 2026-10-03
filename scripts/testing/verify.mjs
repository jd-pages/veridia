import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  CHANGE_RISK_LEVELS,
  e2eFilesForGroup,
  groupE2eFiles,
  selectTestScope,
  validateManifest,
} from "./test-matrix.mjs";
import { invalidateFullGateAttestation, writeFullGateAttestation } from "./full-gate-attestation.mjs";
import { PROTECTED_BEHAVIORS, selectProtectedBehaviors } from "./protected-behaviors.mjs";
import {
  aggregateProtectedBehaviorEvidence,
  readVitestCaseEvidence,
} from "./protected-evidence.mjs";
import {
  classifyReleaseFailure,
  redactReleaseText,
} from "../release-failure.mjs";
import { collectSourceFingerprint } from "../source-fingerprint.mjs";
import { enforcePostE2eProcessQuiescence, validateStoredQuiescenceReceipts, getPostE2eResidualFailureEvidence } from "./post-e2e-process-quiescence.mjs";
import { readFormalNextPrepareEvidence } from "./formal-next-prepare-evidence.mjs";
import { assertNextTraceSingleFlight } from "./next-trace-single-flight.mjs";
import { beginBuildLockDiagnostics, endBuildLockDiagnostics } from "./build-lock-diagnostics.mjs";

const root = process.cwd();
const requestedMode = process.argv[2] || "fast";
if (!new Set(["affected", "fast", "regression", "full"]).has(requestedMode)) throw new Error("验证模式必须是 affected、fast、regression 或 full");

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
  return upstream.status === 0 ? gitLines(["-c", "core.quotepath=false", "diff", "--name-only", "origin/main...HEAD"]) : [];
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
  return { name, passed: !result.error && result.status === 0, status: result.status, error: result.error || null, output: `${result.stdout || ""}\n${result.stderr || ""}\n${result.error?.message || ""}`, durationSeconds };
}

function npm(name, args, options) {
  return command(name, process.platform === "win32" ? "npm.cmd" : "npm", args, options);
}

const unitEvidence = [];
function runVitest(name, args, reportName) {
  const reportFile = path.join(root, ".playwright", `vitest-${mode}-${reportName}.json`);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.rmSync(reportFile, { force: true });
  const result = npm(name, [
    "exec", "--", "vitest", ...args,
    "--reporter=default", "--reporter=json",
    `--outputFile.json=${reportFile}`,
  ]);
  unitEvidence.push(...readVitestCaseEvidence(reportFile, root));
  return result;
}

function passedTestCount(output) {
  const plain = output.replace(/\u001b\[[0-9;]*m/gu, "");
  return Number(plain.match(/Tests\s+(\d+) passed/u)?.[1] || 0);
}

const failures = [];
const failureDetails = [];
const timings = [];
function verificationFailureDetail(result) {
  const plain = redactReleaseText(result.output);
  const failedItem =
    plain.match(/(?:FAIL|\u00d7)\s+([^\r\n]+)/iu)?.[1]?.trim() || result.name;
  const summary =
    plain.match(/(Test timed out in \d+ms|Timeout \d+ms exceeded)/iu)?.[1] ||
    plain.match(/(?:Error|AssertionError):\s*([^\r\n]+)/iu)?.[1]?.trim() ||
    `${result.name} failed`;
  return {
    name: result.name,
    classification: classifyReleaseFailure(summary),
    failedItem,
    summary,
    status: result.status,
  };
}
const record = (result) => {
  timings.push({ name: result.name, seconds: result.durationSeconds, passed: result.passed });
  if (!result.passed) {
    failures.push(result.name);
    failureDetails.push(verificationFailureDetail(result));
  }
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
const affectedMode = mode === "affected" || mode === "fast";
const recoveryGroup = process.env.VERIDIA_TEST_RECOVERY_GROUP?.trim() || "";
if (recoveryGroup && selection?.risk.level !== CHANGE_RISK_LEVELS.TEST_ONLY) {
  throw new Error("TEST_ONLY_RECOVERY 只能用于 tests/** 唯一变化");
}
const recoveryFiles = recoveryGroup ? e2eFilesForGroup(recoveryGroup) : [];
if (recoveryGroup && recoveryFiles.length === 0) {
  throw new Error(`未知 TEST_ONLY_RECOVERY E2E 组：${recoveryGroup}`);
}
const selectedFiles = mode === "full"
  ? formalFiles
  : [...new Set([...selection.e2eFiles, ...recoveryFiles])].sort();
const protectedSelection = mode === "full"
  ? selectProtectedBehaviors(changes, { full: true })
  : {
      behaviorKeys: selection.protectedBehaviorKeys,
      groups: selection.protectedGroups,
      unitTests: selection.protectedUnitTests,
      e2eTests: selectedFiles.filter((file) => selection.e2eFiles.includes(file)),
      reasons: selection.protectedReasons,
    };
process.stdout.write([
  "========================================",
  `VERIDIA ${mode.toUpperCase()} 验证门禁`,
  "========================================",
  `检测到的变更：${changes.length ? changes.join(", ") : "无（保守回退）"}`,
  `风险分类：${mode === "full" ? "RELEASE_FULL" : selection.risk.level}`,
  ...(selection ? selection.risk.reasons.map((reason) => `风险原因：${reason}`) : []),
  `选择分类：${mode === "full" ? "全部正式分类" : selection.categories.join(", ")}`,
  ...(selection ? [
    `Unit 显式文件（${selection.unitFiles.length}）：${selection.unitFiles.join(", ") || "无"}`,
    `Unit related 生产源（${selection.unitRelatedFiles.length}）：${selection.unitRelatedFiles.join(", ") || "无"}`,
    ...selection.unitSelectionReasons.map((reason) => `Unit 选择原因：${reason}`),
  ] : []),
  `E2E 文件（${selectedFiles.length}/${formalFiles.length}）：${selectedFiles.join(", ")}`,
  `PROTECTED_REGRESSION 组：${protectedSelection.groups.join(", ") || "无"}`,
  `PROTECTED_REGRESSION 行为（${protectedSelection.behaviorKeys.length}）：${protectedSelection.behaviorKeys.join(", ") || "无"}`,
  ...(selection ? selection.reasons.map((reason) => `选择原因：${reason}`) : ["选择原因：FULL 明确执行全部正式 E2E；不使用变更选择器"]),
  ...protectedSelection.reasons.map((reason) => `Protected 选择原因：${reason}`),
  recoveryGroup ? `TEST_ONLY_RECOVERY：完整重跑 ${recoveryGroup}` : "TEST_ONLY_RECOVERY：不适用",
  mode === "full" ? "执行策略：完整报告，单个业务失败不阻断其余独立门禁" : `执行策略：${affectedMode ? "受影响测试 fail-fast，不执行 FULL" : "受影响业务分组 + 受保护行为"}`,
  "",
].join("\n"));

if (mode === "full") invalidateFullGateAttestation(root);

const protectedRegistry = record(command("Protected behavior registry", process.execPath, [path.join(root, "scripts", "testing", "protected-behaviors.mjs")]));
record(npm("Prisma Client", ["run", "db:generate"]));
record(npm("Prisma Client assert", ["run", "prisma:assert"]));
const highRiskKinds = new Set(selection?.risk.highRiskKinds || []);
if (affectedMode && highRiskKinds.has("desktopRuntime")) {
  record(npm("Desktop bundled Node", ["run", "desktop:node:prepare"]));
}
record(npm("Lint", ["run", "lint"]));
record(npm("Typecheck", ["run", "typecheck"]));

let unitTotal = 0;
const unitCommandNames = [];
if (affectedMode) {
  if (selection.unitFiles.length) {
    const name = "Affected explicit unit";
    unitCommandNames.push(name);
    const unit = record(runVitest(name, ["run", ...selection.unitFiles], "affected-explicit"));
    unitTotal = passedTestCount(unit.output);
  }
  if (selection.unitRelatedFiles.length) {
    const name = "Affected related unit";
    unitCommandNames.push(name);
    const unit = record(runVitest(name, [
      "related", ...selection.unitRelatedFiles, "--run", "--passWithNoTests",
      ...selection.unitFiles.flatMap((file) => ["--exclude", file]),
    ], "affected-related"));
    unitTotal += passedTestCount(unit.output);
  }
} else {
  const name = "All unit tests";
  unitCommandNames.push(name);
  const unit = record(runVitest(name, ["run"], "all"));
  unitTotal = passedTestCount(unit.output);
}
const affectedUnitFiles = affectedMode
  ? [...new Set([...selection.unitFiles, ...unitEvidence.map((item) => item.file)])].sort()
  : [];
if (affectedMode) {
  process.stdout.write(`AFFECTED_UNIT_FILES=${affectedUnitFiles.length}\n`);
  process.stdout.write(`AFFECTED_UNIT_CASES=${unitEvidence.length}\n`);
}

let e2eTotal = 0;
let e2ePassed = 0;
let e2eExecuted = 0;
let e2eFailed = 0;
let e2eNotRun = 0;
const e2eEvidence = [];
const e2eGroups = [];
const groups = groupE2eFiles(selectedFiles);
const e2eQuiescenceReceipts = [];
const e2ePhaseStartedAt = new Date().toISOString();
const verificationHead = gitLines(["rev-parse", "HEAD"])[0];
const verificationSourceFingerprint = collectSourceFingerprint(root);
for (const group of groups) {
  const result = record(command(`E2E ${group.name}`, process.execPath, [
    path.join(root, "scripts", "testing", "run-e2e.mjs"),
    `--group=${group.name}`,
    `--workers=${group.workers}`,
    ...(affectedMode ? ["--fail-fast"] : []),
    ...group.files,
  ]));
  const marker = result.output.match(/VERIDIA_E2E_RESULT=(\{[^\r\n]+\})/u);
  const receiptMarkers = [...result.output.matchAll(/VERIDIA_E2E_QUIESCENCE=(\{[^\r\n]+\})/gu)];
  try { e2eQuiescenceReceipts.push(receiptMarkers.length === 1 ? JSON.parse(receiptMarkers[0][1]) : null); }
  catch { e2eQuiescenceReceipts.push(null); }
  if (marker) {
    const summary = JSON.parse(marker[1]);
    e2eTotal += summary.total;
    e2ePassed += summary.passed;
    e2eExecuted += summary.executed;
    e2eFailed += summary.failed;
    e2eNotRun += summary.notRun;
    e2eEvidence.push(...(summary.cases || []));
    e2eGroups.push({
      name: group.name,
      files: group.files,
      total: summary.total,
      passed: summary.passed,
      executed: summary.executed,
      failed: summary.failed,
      notRun: summary.notRun,
      status: result.passed ? "PASSED" : "FAILED",
    });
  }
  if (!result.passed && affectedMode) break;
}

let postE2eProcessQuiescence = { status: "NOT_REQUIRED" };
let productionBuildStatus = "NOT_REQUIRED";
let standaloneStatus = "NOT_REQUIRED";
let formalNextPreparation = { status: "NOT_REQUIRED" };
let buildLockDiagnostics = { status: "NOT_REQUIRED" };
async function guardedProductionBuild(withStandalone) {
  if (groups.length > 0) {
    const started = Date.now();
    try {
      if (gitLines(["rev-parse", "HEAD"])[0] !== verificationHead || collectSourceFingerprint(root) !== verificationSourceFingerprint) {
        throw new Error("SOURCE_CHANGED_BEFORE_BUILD_HANDOFF");
      }
      const context = { root, groups: groups.map(group => group.name), receipts: e2eQuiescenceReceipts,
        head: verificationHead, sourceFingerprint: verificationSourceFingerprint,
        startedAt: e2ePhaseStartedAt, now: new Date().toISOString() };
      if (process.platform === "win32") validateStoredQuiescenceReceipts(context);
      postE2eProcessQuiescence = await enforcePostE2eProcessQuiescence(context);
      if (gitLines(["rev-parse", "HEAD"])[0] !== verificationHead || collectSourceFingerprint(root) !== verificationSourceFingerprint) {
        throw new Error("SOURCE_CHANGED_DURING_BUILD_HANDOFF_FENCE");
      }
      record({ name: "POST_E2E_PROCESS_QUIESCENCE", passed: ["PASSED", "NOT_APPLICABLE"].includes(postE2eProcessQuiescence.status),
        status: 0, output: JSON.stringify(postE2eProcessQuiescence), durationSeconds: (Date.now() - started) / 1000 });
    } catch (error) {
      postE2eProcessQuiescence = { status: "FAILED", error: redactReleaseText(error instanceof Error ? error.message : String(error)) };
      const residualEvidence = getPostE2eResidualFailureEvidence(error);
      if (residualEvidence) postE2eProcessQuiescence.nativeResidualEvidence = residualEvidence;
      record({ name: "POST_E2E_PROCESS_QUIESCENCE", passed: false, status: 1,
        output: `Error: ${postE2eProcessQuiescence.error}`, durationSeconds: (Date.now() - started) / 1000 });
    }
    process.stdout.write(`POST_E2E_PROCESS_QUIESCENCE=${JSON.stringify(postE2eProcessQuiescence)}\n`);
    if (postE2eProcessQuiescence.status === "FAILED") {
      productionBuildStatus = "NOT_RUN";
      standaloneStatus = withStandalone ? "NOT_RUN" : "NOT_REQUIRED";
      process.stdout.write("Production build NOT_RUN: preceding native E2E quiescence was not verified\n");
      return;
    }
  }
  let lockSession;
  const lockStarted = Date.now();
  try {
    lockSession = await beginBuildLockDiagnostics({ root, head: verificationHead,
      sourceFingerprint: verificationSourceFingerprint, wrapperPath: path.join(root, "scripts", "testing", "verify.mjs") });
    if (gitLines(["rev-parse", "HEAD"])[0] !== verificationHead || collectSourceFingerprint(root) !== verificationSourceFingerprint) {
      throw new Error("SOURCE_CHANGED_DURING_BUILD_DIAGNOSTIC_READINESS");
    }
  } catch (error) {
    try {
      buildLockDiagnostics = lockSession
        ? await endBuildLockDiagnostics(lockSession, { buildStatus: null, buildStartedAt: null, buildEndedAt: null, buildError: error })
        : { ...(error?.diagnostics || {}), status: "DIAGNOSTICS_INCOMPLETE",
            error: redactReleaseText(error instanceof Error ? error.message : String(error)) };
    } catch (endError) {
      buildLockDiagnostics = { status: "DIAGNOSTICS_INCOMPLETE", receiptRelativePath: lockSession?.receiptRelativePath,
        error: redactReleaseText(error instanceof Error ? error.message : String(error)),
        endError: redactReleaseText(endError instanceof Error ? endError.message : String(endError)) };
    }
    productionBuildStatus = "NOT_RUN";
    standaloneStatus = withStandalone ? "NOT_RUN" : "NOT_REQUIRED";
    record({ name: "Build lock diagnostics", passed: false, status: 1,
      output: `Error: BUILD_DIAGNOSTIC_READINESS_FAILED\n${JSON.stringify(buildLockDiagnostics)}`, durationSeconds: (Date.now() - lockStarted) / 1000 });
    process.stdout.write(`VERIDIA_BUILD_LOCK_DIAGNOSTICS=${JSON.stringify(buildLockDiagnostics)}\n`);
    return;
  }
  const buildStartedAt = new Date().toISOString();
  let productionBuild;
  let buildThrownError;
  try {
    // The existing native Build executes exactly once, without a new timeout or retry.
    productionBuild = record(npm("Production build", ["run", "build"], { env: lockSession.environment }));
  } catch (error) {
    buildThrownError = error;
    throw error;
  } finally {
    const buildEndedAt = new Date().toISOString();
    try {
      buildLockDiagnostics = await endBuildLockDiagnostics(lockSession, { buildStatus: productionBuild?.status ?? null,
        buildStartedAt, buildEndedAt, buildError: buildThrownError || productionBuild?.error || undefined,
        monitorIncomplete: productionBuild?.output.includes("VERIDIA_BUILD_LOCK_MONITOR_INCOMPLETE") === true });
    } catch (error) {
      // A diagnostics failure must never replace the original native Build failure.
      buildLockDiagnostics = { status: "DIAGNOSTICS_INCOMPLETE", receiptRelativePath: lockSession.receiptRelativePath,
        error: redactReleaseText(error instanceof Error ? error.message : String(error)) };
    }
    record({ name: "Build lock diagnostics", passed: ["PASSED", "NOT_APPLICABLE"].includes(buildLockDiagnostics.status),
      status: ["PASSED", "NOT_APPLICABLE"].includes(buildLockDiagnostics.status) ? 0 : 1,
      output: JSON.stringify(buildLockDiagnostics), durationSeconds: (Date.now() - lockStarted) / 1000 });
    process.stdout.write(`VERIDIA_BUILD_LOCK_DIAGNOSTICS=${JSON.stringify(buildLockDiagnostics)}\n`);
  }
  productionBuildStatus = productionBuild.passed ? "PASSED" : "FAILED";
  if (productionBuild.passed) {
    const started = Date.now();
    try {
      formalNextPreparation = readFormalNextPrepareEvidence(productionBuild.output, { root, head: verificationHead,
        sourceFingerprint: verificationSourceFingerprint, startedAt: buildStartedAt, now: new Date().toISOString() });
      await assertNextTraceSingleFlight();
      record({ name: "Formal Next prepare identity", passed: true, status: 0, output: JSON.stringify(formalNextPreparation), durationSeconds: (Date.now() - started) / 1000 });
    } catch (error) {
      formalNextPreparation = { status: "FAILED", error: redactReleaseText(error instanceof Error ? error.message : String(error)) };
      record({ name: "Formal Next prepare identity", passed: false, status: 1, output: `Error: ${formalNextPreparation.error}`, durationSeconds: (Date.now() - started) / 1000 });
    }
  } else formalNextPreparation = { status: "NOT_RUN" };
  if (withStandalone) {
    standaloneStatus = "NOT_RUN";
    if (productionBuild.passed && formalNextPreparation.status === "PASSED") {
      const standalone = record(npm("Standalone runtime", ["run", "test:standalone-runtime", "--", "--skip-build"]));
      standaloneStatus = standalone.passed ? "PASSED" : "FAILED";
    }
  }
}

if (!affectedMode) {
  await guardedProductionBuild(true);
}
if (affectedMode && highRiskKinds.has("database")) {
  record(command("Database compatibility", process.execPath, [path.join(root, "scripts", "testing", "verify-databases.mjs")]));
}
if (affectedMode && highRiskKinds.has("desktopRuntime")) {
  record(npm("Desktop health", ["run", "test:desktop-health"]));
}
if (affectedMode && highRiskKinds.has("packageRuntime")) {
  await guardedProductionBuild(false);
}
if (mode === "full") {
  record(command("Database compatibility", process.execPath, [path.join(root, "scripts", "testing", "verify-databases.mjs")]));
  record(npm("Desktop health", ["run", "test:desktop-health"]));
  record(npm("Sensitive scan", ["run", "scan:sensitive"]));
}
record(command("git diff --check", "git", ["diff", "--check"]));
record(command("git diff --cached --check", "git", ["diff", "--cached", "--check"]));
const sourceIdentityStarted = Date.now();
const sourceIdentityStable = gitLines(["rev-parse", "HEAD"])[0] === verificationHead && collectSourceFingerprint(root) === verificationSourceFingerprint;
record({ name: "Verification source identity", passed: sourceIdentityStable, status: sourceIdentityStable ? 0 : 1,
  output: sourceIdentityStable ? "Exact HEAD and source fingerprint unchanged" : "Error: SOURCE_CHANGED_DURING_VERIFICATION", durationSeconds: (Date.now() - sourceIdentityStarted) / 1000 });

const protectedEvidence = aggregateProtectedBehaviorEvidence({
  root,
  behaviorKeys: protectedSelection.behaviorKeys,
  behaviors: PROTECTED_BEHAVIORS,
  unitEvidence,
  e2eEvidence,
  registryPassed: protectedRegistry.passed,
});
const protectedRegression = protectedEvidence.status;
const protectedBehaviors = protectedEvidence.behaviors;

const summary = {
  gitHead: verificationHead,
  sourceFingerprint: verificationSourceFingerprint,
  sourceChangedDuringVerification: !sourceIdentityStable,
  mode: mode.toUpperCase(),
  requestedMode: requestedMode.toUpperCase(),
  passed: failures.length === 0 && !["FAILED"].includes(protectedRegression),
  failures,
  firstFailure: failureDetails[0] || null,
  failureDetails,
  e2eTotal,
  e2ePassed,
  e2eExecuted,
  e2eFailed,
  e2eNotRun,
  selectedE2eFiles: selectedFiles,
  e2eGroups,
  risk: mode === "full"
    ? { level: "RELEASE_FULL", highRiskKinds: [], productionChanged: true }
    : selection.risk,
  recoveryGroup: recoveryGroup || null,
  selectedUnitFiles: affectedMode ? affectedUnitFiles : null,
  unitRelatedFiles: affectedMode ? selection.unitRelatedFiles : null,
  affectedUnitCases: affectedMode ? unitEvidence.length : null,
  unitTests: {
    passed: unitCommandNames.some((name) => failures.includes(name)) ? 0 : unitTotal,
    total: affectedMode ? unitEvidence.length : unitTotal,
  },
  productionBuild: productionBuildStatus,
  standaloneRuntime: standaloneStatus,
  postE2eProcessQuiescence,
  formalNextPreparation,
  buildLockDiagnostics,
  sqliteFreshMigration: (mode === "full" || highRiskKinds.has("database"))
    ? failures.includes("Database compatibility") ? "FAILED" : "PASSED"
    : "NOT_REQUIRED",
  sqliteLegacyUpgrade: (mode === "full" || highRiskKinds.has("database"))
    ? failures.includes("Database compatibility") ? "FAILED" : "PASSED"
    : "NOT_REQUIRED",
  postgresValidate: (mode === "full" || highRiskKinds.has("database"))
    ? failures.includes("Database compatibility") ? "FAILED" : "PASSED"
    : "NOT_REQUIRED",
  sensitiveScan: mode === "full" && !failures.includes("Sensitive scan") ? "PASSED" : mode === "full" ? "FAILED" : "NOT_REQUIRED",
  gitDiffCheck: !failures.some((name) => name.startsWith("git diff")) ? "PASSED" : "FAILED",
  lint: failures.includes("Lint") ? "FAILED" : "PASSED",
  typecheck: failures.includes("Typecheck") ? "FAILED" : "PASSED",
  protectedRegression,
  protectedGroups: protectedSelection.groups,
  protectedBehaviors,
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
process.stdout.write(`PROTECTED_BEHAVIOR_REGRESSION=${protectedRegression}\n`);
process.stdout.write(`PASS: ${protectedBehaviors.filter((item) => item.status === "PASSED").map((item) => item.key).join(", ") || "无"}\n`);
process.stdout.write(`FAILED: ${protectedBehaviors.filter((item) => item.status === "FAILED").map((item) => item.key).join(", ") || "无"}\n`);
if (!summary.passed) process.exitCode = 1;
