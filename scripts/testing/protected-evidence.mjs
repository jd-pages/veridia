import fs from "node:fs";
import path from "node:path";

const normalizedFile = (file, root = process.cwd()) => {
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file);
  return path.relative(root, absolute).replaceAll("\\", "/");
};

export const protectedCaseKey = (file, title, root = process.cwd()) =>
  `${normalizedFile(file, root)}::${title}`;

export function readVitestCaseEvidence(reportFile, root = process.cwd()) {
  if (!fs.existsSync(reportFile)) return [];
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  return (report.testResults || []).flatMap((suite) =>
    (suite.assertionResults || []).map((test) => ({
      file: normalizedFile(suite.name, root),
      title: test.title,
      status: test.status === "passed" ? "PASSED" : "FAILED",
    })),
  );
}

export function readPlaywrightCaseEvidence(reportFile, root = process.cwd()) {
  if (!fs.existsSync(reportFile)) return [];
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  const evidence = [];
  const visit = (suite) => {
    for (const spec of suite.specs || []) {
      // spec.ok also includes skipped/unstarted cases after max-failures.
      // A retry is judged by its final actual attempt, across every project.
      const statuses = (spec.tests || []).map((test) => {
        const last = (test.results || []).filter((result) => result.status !== "skipped").at(-1);
        return !last ? "NOT_RUN" : last.status === "passed" ? "PASSED" : "FAILED";
      });
      const status = statuses.includes("FAILED") ? "FAILED"
        : statuses.length > 0 && statuses.every((item) => item === "PASSED") ? "PASSED" : "NOT_RUN";
      evidence.push({
        file: (() => {
          const file = normalizedFile(spec.file || suite.file, root);
          return file.startsWith("tests/e2e/") ? file : `tests/e2e/${file}`;
        })(),
        title: spec.title,
        status,
      });
    }
    for (const child of suite.suites || []) visit(child);
  };
  for (const suite of report.suites || []) visit(suite);
  return evidence;
}

export function summarizePlaywrightCaseEvidence(cases, selectedTotal = cases.length) {
  const total = Math.max(selectedTotal, cases.length);
  const passed = cases.filter((item) => item.status === "PASSED").length;
  const failed = cases.filter((item) => item.status === "FAILED").length;
  const executed = passed + failed;
  return { total, executed, passed, failed, notRun: total - executed };
}

export function aggregateProtectedBehaviorEvidence(input) {
  const evidence = new Map(
    [...input.unitEvidence, ...input.e2eEvidence].map((item) => [
      protectedCaseKey(item.file, item.title, input.root),
      item.status,
    ]),
  );
  const selected = new Set(input.behaviorKeys);
  const behaviors = input.behaviors
    .filter((behavior) => selected.has(behavior.key))
    .map((behavior) => {
      const required = [...(behavior.unitCases || []), ...(behavior.e2eCases || [])];
      const cases = required.map((item) => ({
        ...item,
        status: evidence.get(protectedCaseKey(item.file, item.title, input.root)) || "NOT_RUN",
      }));
      const status = input.registryPassed && cases.length > 0 && cases.every((item) => item.status === "PASSED")
        ? "PASSED"
        : "FAILED";
      return { key: behavior.key, status, cases };
    });
  return {
    status: behaviors.length === 0
      ? "NOT_APPLICABLE"
      : behaviors.every((item) => item.status === "PASSED") ? "PASSED" : "FAILED",
    behaviors,
  };
}
