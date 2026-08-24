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
      const results = (spec.tests || []).flatMap((test) => test.results || []);
      const passed = spec.ok === true || (
        results.length > 0 && results.every((result) => result.status === "passed")
      );
      evidence.push({
        file: (() => {
          const file = normalizedFile(spec.file || suite.file, root);
          return file.startsWith("tests/e2e/") ? file : `tests/e2e/${file}`;
        })(),
        title: spec.title,
        status: passed ? "PASSED" : "FAILED",
      });
    }
    for (const child of suite.suites || []) visit(child);
  };
  for (const suite of report.suites || []) visit(suite);
  return evidence;
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
