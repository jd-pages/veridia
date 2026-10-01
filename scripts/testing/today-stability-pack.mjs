import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { groupE2eFiles } from "./test-matrix.mjs";
import { readVitestCaseEvidence } from "./protected-evidence.mjs";
import { redactE2eDiagnosticText } from "./e2e-server-infrastructure.mjs";
import { collectSourceFingerprint } from "../source-fingerprint.mjs";

// This focused pack supplements, never replaces, the formal FULL gate.
// Every E2E invocation keeps the official resource/singleton grouping and owns
// its isolated database, profiles and port through run-e2e.mjs.
export const TODAY_STABILITY_REGRESSION_PACK = Object.freeze([
  { key: "BATCH_CREATION", unit: [], e2e: ["tests/e2e/product-stage-topic.spec.ts"] },
  { key: "IMPORT_PREVIEW_TABLE_SCOPE", unit: [], e2e: ["tests/e2e/audit-flow.spec.ts", "tests/e2e/import-preflight-layout.spec.ts"] },
  { key: "RULE_MONTH_SELECTION", unit: [], e2e: ["tests/e2e/product-stage-topic.spec.ts", "tests/e2e/rule-brand-navigation.spec.ts"] },
  { key: "DASHBOARD_LOCAL_MONTH_SCOPE", unit: ["tests/unit/dashboard-calendar-month.test.ts", "tests/unit/dashboard-risk-summary-ui.test.ts"], e2e: ["tests/e2e/dashboard-risk-summary.spec.ts"] },
  { key: "PRISMA_TRANSACTION_QUIESCENCE", unit: ["tests/unit/prisma-transaction-diagnostics.test.ts"], e2e: ["tests/e2e/pause-resume-runner-lifecycle.spec.ts"] },
  { key: "PAUSE_CONTINUE_RUNNER_HANDOFF", unit: ["tests/unit/automation-runner-lifecycle.test.ts"], e2e: ["tests/e2e/pause-resume-runner-lifecycle.spec.ts"] },
  { key: "QUEUE_PAUSED_A07", unit: ["tests/unit/automation-queue-timeout-invariant.test.ts"], e2e: ["tests/e2e/queue-paused-batch.spec.ts"] },
  { key: "HISTORICAL_EXTRACTION_IMMUTABLE", unit: ["tests/unit/audit-extraction-snapshot.test.ts", "tests/unit/audit-extraction-snapshot-api.test.ts", "tests/unit/audit-result-presentation.test.ts"], e2e: ["tests/e2e/historical-extraction-immutable.spec.ts"] },
  { key: "PERSISTENT_CONTEXT_CLOSE", unit: ["tests/unit/automation-browser-session.test.ts", "tests/unit/xhs-browser-lifecycle-deadline.test.ts", "tests/unit/windows-browser-process-owner.test.ts", "tests/unit/windows-hidden-chromium-close.test.ts", "tests/unit/douyin-browser-physical-fence.test.ts"], e2e: ["tests/e2e/pause-resume-runner-lifecycle.spec.ts"] },
  { key: "BROWSER_CLEANUP_DEADLINE", unit: ["tests/unit/browser-lifecycle-liveness.test.ts", "tests/unit/xhs-browser-lifecycle-deadline.test.ts", "tests/unit/windows-browser-process-owner.test.ts", "tests/unit/windows-hidden-chromium-close.test.ts", "tests/unit/douyin-browser-physical-fence.test.ts"], e2e: ["tests/e2e/pause-resume-runner-lifecycle.spec.ts"] },
  { key: "GENERATION_LIFECYCLE", unit: ["tests/unit/automation-runner-lifecycle.test.ts", "tests/unit/browser-lifecycle-liveness.test.ts"], e2e: ["tests/e2e/queue-paused-batch.spec.ts"] },
  { key: "SERVER_HEALTH_BATCH_POST", unit: ["tests/unit/e2e-readiness.test.ts", "tests/unit/e2e-api-request.test.ts", "tests/unit/e2e-server-infrastructure.test.ts", "tests/unit/warmup-api-auth-cookie-snapshot.test.ts"], e2e: ["tests/e2e/product-stage-topic.spec.ts", "tests/e2e/results-workbench.spec.ts"] },
  { key: "CRLF_PORTABILITY", unit: ["tests/unit/automation-runner-lifecycle.test.ts"], e2e: [] },
  { key: "VITEST_HIGH_DURATION", unit: ["tests/unit/xhs-readiness.test.ts", "tests/unit/audit-extraction-snapshot-api.test.ts"], e2e: [] },
  { key: "FROZEN_KABRITA_OCTOBER_CONTRACT", unit: ["tests/unit/kabrita-october-reward.test.ts", "tests/unit/result-next-review-date.test.ts", "tests/unit/import-export-templates.test.ts"], e2e: ["tests/e2e/kabrita-october-reward.spec.ts", "tests/e2e/unified-excel-template.spec.ts"] },
  { key: "FROZEN_PRODUCT_CAMPAIGN_MEMBERSHIP", unit: ["tests/unit/campaign-product-membership.test.ts"], e2e: ["tests/e2e/product-campaign-membership.spec.ts"] },
  { key: "FROZEN_DOUYIN_FAIL_STOP", unit: ["tests/unit/douyin-real-video-detail-recognition.test.ts", "tests/unit/douyin-visible-content-id-scope.test.ts"], e2e: ["tests/e2e/douyin-automation.spec.ts"] },
  { key: "FROZEN_RETENTION_STORE_TOPIC", unit: ["tests/unit/retention-pending-workflow.test.ts", "tests/unit/store-topic-channel-policy.test.ts", "tests/unit/store-topic-config.test.ts"], e2e: ["tests/e2e/store-topic-audit.spec.ts"] },
  { key: "FORMAL_BUILD_FILE_LOCK_STABILITY", unit: ["tests/unit/next-trace-single-flight.test.ts", "tests/unit/build-lock-diagnostics.test.ts"], e2e: [] },
  { key: "POST_E2E_PROCESS_QUIESCENCE", unit: ["tests/unit/e2e-server-infrastructure.test.ts", "tests/unit/e2e-browser-teardown.test.ts", "tests/unit/post-e2e-process-quiescence.test.ts", "tests/unit/runtime-observation-worker.test.ts"], e2e: ["tests/e2e/product-stage-topic.spec.ts", "tests/e2e/pause-resume-runner-lifecycle.spec.ts"] },
  { key: "NEXT_DIST_ISOLATION", unit: ["tests/unit/test-gates.test.ts", "tests/unit/next-typegen-lifecycle.test.ts"], e2e: ["tests/e2e/product-stage-topic.spec.ts"] },
  { key: "NEXT_TYPEGEN_PROCESS_CLEANUP", unit: ["tests/unit/next-typegen-lifecycle.test.ts", "tests/unit/formal-next-prepare-evidence.test.ts"], e2e: [] },
]);

export function stabilityPackSelection(root = process.cwd()) {
  const unitFiles = [...new Set(TODAY_STABILITY_REGRESSION_PACK.flatMap((entry) => entry.unit))].sort();
  const e2eFiles = [...new Set(TODAY_STABILITY_REGRESSION_PACK.flatMap((entry) => entry.e2e))].sort();
  for (const file of [...unitFiles, ...e2eFiles]) {
    if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing stability protection: ${file}`);
  }
  return { categories: TODAY_STABILITY_REGRESSION_PACK.map((entry) => entry.key), unitFiles, e2eGroups: groupE2eFiles(e2eFiles), retries: 0 };
}

export function actualE2eSummary(output) {
  const marker = output.split(/\r?\n/u).filter((line) => line.startsWith("VERIDIA_E2E_RESULT=")).at(-1);
  if (!marker) return null;
  const summary = JSON.parse(marker.slice("VERIDIA_E2E_RESULT=".length));
  const executions = summary.executionSummary;
  const executionCounters = ["total", "executed", "passed", "failed", "notRun", "retryCount"];
  const executionsPassed = Boolean(executions
    && executionCounters.every((key) => Number.isSafeInteger(executions[key]) && executions[key] >= 0)
    && executions.total > 0 && executions.executed === executions.total && executions.passed === executions.total
    && executions.failed === 0 && executions.notRun === 0 && executions.retryCount === 0);
  return { ...summary, passedAll: summary.total > 0 && summary.executed === summary.total && summary.passed === summary.total && summary.failed === 0 && summary.notRun === 0 && executionsPassed };
}

export function sanitizeStabilityOutput(output, secrets = []) {
  return redactE2eDiagnosticText(output, secrets);
}

export async function runStabilityPack(args = process.argv.slice(2), root = process.cwd()) {
  const allowed = new Set(["--list", "--unit-only", "--e2e-only"]);
  if (args.some((arg) => !allowed.has(arg)) || (args.includes("--unit-only") && args.includes("--e2e-only"))) {
    throw new Error("Supported modes: --list, --unit-only or --e2e-only; no retries or FULL invocation");
  }
  const selection = stabilityPackSelection(root);
  if (args.includes("--list")) {
    process.stdout.write(`${JSON.stringify(selection, null, 2)}\n`);
    return selection;
  }
  const id = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const directory = path.join(root, ".playwright", "stability-packs", id);
  fs.mkdirSync(directory, { recursive: true });
  const reportFile = path.join(directory, "summary.json");
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (git.status !== 0) throw new Error("Unable to bind stability evidence to HEAD");
  const report = { schemaVersion: 1, runId: id, head: git.stdout.trim(), sourceFingerprint: collectSourceFingerprint(root), startedAt: new Date().toISOString(), retries: 0, selection, steps: [], status: "RUNNING", formalFull: "NOT_RUN" };
  const persist = () => fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  persist();
  const command = (name, commandArgs) => {
    process.stdout.write(`[Today stability] ${name} started\n`);
    const started = Date.now();
    const result = spawnSync(process.execPath, commandArgs, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 100 * 1024 * 1024 });
    const output = `${result.stdout || ""}\n${result.stderr || ""}\n${result.error?.message || ""}`;
    const logFile = path.join(directory, `${name}.log`);
    fs.writeFileSync(logFile, sanitizeStabilityOutput(output, [process.env.AUTH_SECRET, process.env.EXTENSION_TOKEN, process.env.OPENAI_API_KEY]));
    const step = { name, status: result.status === 0 && !result.error ? "PASS" : "FAILED", exitCode: result.status, durationMs: Date.now() - started, logFile };
    report.steps.push(step);
    persist();
    process.stdout.write(`[Today stability] ${name} ${step.status} (${step.durationMs}ms)\n`);
    return { step, output };
  };
  try {
    if (!args.includes("--e2e-only")) {
      const unitFile = path.join(directory, "unit.json");
      const { step } = command("UNIT", [path.join(root, "node_modules", "vitest", "vitest.mjs"), "run", ...selection.unitFiles, "--reporter=default", "--reporter=json", `--outputFile.json=${unitFile}`]);
      const cases = readVitestCaseEvidence(unitFile, root);
      step.cases = cases;
      step.passed = cases.filter((item) => item.status === "PASSED").length;
      step.failed = cases.filter((item) => item.status !== "PASSED").length;
      if (step.status !== "PASS" || cases.length === 0 || step.failed > 0) throw new Error("Stability Unit failed or missing actual case evidence");
    }
    if (!args.includes("--unit-only")) {
      for (const group of selection.e2eGroups) {
        const { step, output } = command(`E2E_${group.name}`, [path.join(root, "scripts", "testing", "run-e2e.mjs"), ...group.files, `--workers=${group.workers}`, `--group=TODAY_${group.name}_${id}`, "--fail-fast"]);
        step.summary = actualE2eSummary(output);
        if (step.status !== "PASS" || !step.summary?.passedAll) throw new Error(`Stability ${group.name} failed or left NOT_RUN cases`);
      }
    }
    report.status = args.includes("--unit-only") || args.includes("--e2e-only") ? "PARTIAL_PASS" : "PASS";
  } catch (error) {
    report.status = "FAILED";
    report.failure = String(error?.message || error);
    process.exitCode = 1;
  } finally {
    report.finalSourceFingerprint = collectSourceFingerprint(root);
    report.sourceChangedDuringPack = report.finalSourceFingerprint !== report.sourceFingerprint;
    if (report.sourceChangedDuringPack) {
      report.status = "FAILED";
      report.failure = "SOURCE_CHANGED_DURING_STABILITY_PACK";
      process.exitCode = 1;
    }
    report.completedAt = new Date().toISOString();
    persist();
    process.stdout.write(`TODAY_STABILITY_RESULT=${JSON.stringify({ status: report.status, reportFile, head: report.head, retries: 0 })}\n`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runStabilityPack().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
}
