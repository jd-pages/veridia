import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ATTESTATION_SCHEMA_VERSION = 1;
export const ATTESTATION_RELATIVE_PATH = ".release-work/verification/full-gate-attestation.json";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
}

function hashFiles(root, files) {
  const hash = createHash("sha256");
  for (const relative of [...files].sort()) {
    const absolute = path.join(root, relative);
    hash.update(`${relative}\0`);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) hash.update(fs.readFileSync(absolute));
    else hash.update("<missing>");
  }
  return hash.digest("hex");
}

function recursiveFiles(root, relativeDirectory, predicate = () => true) {
  const directory = path.join(root, relativeDirectory);
  if (!fs.existsSync(directory)) return [];
  const output = [];
  const visit = (current, relative) => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const childRelative = `${relative}/${item.name}`.replace(/^\//u, "");
      if (item.isDirectory()) visit(path.join(current, item.name), childRelative);
      else if (item.isFile() && predicate(childRelative)) output.push(childRelative);
    }
  };
  visit(directory, relativeDirectory);
  return output.sort();
}

export function collectAttestationState(root = process.cwd()) {
  const testFiles = [
    ...recursiveFiles(root, "tests/e2e", (file) => /\.(?:spec|test)\.ts$|setup-database\.ts$/u.test(file)),
    ...recursiveFiles(root, "tests/unit", (file) => file.endsWith(".test.ts")),
  ];
  const migrationFiles = recursiveFiles(root, "prisma/migrations");
  const verificationScripts = [
    ...recursiveFiles(root, "scripts/testing"),
    "scripts/release.mjs",
    "scripts/fixed-workflow.mjs",
    "scripts/sensitive-scan.mjs",
  ];
  const status = git(root, ["status", "--porcelain", "--untracked-files=normal"]);
  return {
    gitHead: git(root, ["rev-parse", "HEAD"]),
    gitBranch: git(root, ["branch", "--show-current"]),
    workingTreeClean: status.length === 0,
    packageLockHash: hashFiles(root, ["package-lock.json"]),
    packageJsonHash: hashFiles(root, ["package.json"]),
    playwrightConfigHash: hashFiles(root, ["playwright.config.ts"]),
    testManifestHash: hashFiles(root, testFiles),
    prismaMigrationHash: hashFiles(root, migrationFiles),
    prismaSchemaHash: hashFiles(root, ["prisma/schema.prisma", "prisma/schema.postgresql.prisma"]),
    relevantScriptsHash: hashFiles(root, verificationScripts),
    e2eDatabaseTemplateFingerprint: hashFiles(root, [
      "prisma/schema.prisma",
      ...migrationFiles,
      "tests/e2e/setup-database.ts",
      "scripts/testing/e2e-database-template.mjs",
    ]),
    nodeVersion: process.versions.node,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    platform: process.platform,
    architecture: process.arch,
  };
}

export function attestationPath(root = process.cwd()) {
  return path.join(root, ...ATTESTATION_RELATIVE_PATH.split("/"));
}

export function invalidateFullGateAttestation(root = process.cwd()) {
  fs.rmSync(attestationPath(root), { force: true });
}

export function writeFullGateAttestation(results, root = process.cwd()) {
  const requiredPasses = [
    results?.passed === true,
    results?.mode === "FULL",
    results?.lint === "PASSED",
    results?.typecheck === "PASSED",
    results?.unitTests?.total > 0 && results?.unitTests?.passed === results?.unitTests?.total,
    results?.e2eTotal > 0 && results?.e2ePassed === results?.e2eTotal,
    results?.productionBuild === "PASSED",
    results?.sqliteFreshMigration === "PASSED",
    results?.sqliteLegacyUpgrade === "PASSED",
    results?.postgresValidate === "PASSED",
    results?.sensitiveScan === "PASSED",
    results?.gitDiffCheck === "PASSED",
  ];
  if (!requiredPasses.every(Boolean)) {
    invalidateFullGateAttestation(root);
    throw new Error("只有全部正式检查真实通过的 verify:full 才能生成 FULL 凭证");
  }
  const state = collectAttestationState(root);
  if (!state.workingTreeClean) {
    throw new Error("FULL 已通过，但工作区不干净，不能生成可复用凭证");
  }
  const document = {
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    verificationMode: "FULL",
    ...state,
    results,
  };
  const output = attestationPath(root);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return document;
}

export function validateFullGateAttestation(root = process.cwd()) {
  const file = attestationPath(root);
  if (!fs.existsSync(file)) return { valid: false, reasons: ["未找到 FULL 验收凭证"] };
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { valid: false, reasons: ["FULL 验收凭证已损坏"] };
  }
  if (saved.schemaVersion !== ATTESTATION_SCHEMA_VERSION) {
    return { valid: false, reasons: [`凭证 schemaVersion 不兼容: ${saved.schemaVersion ?? "缺失"}`] };
  }
  if (saved.verificationMode !== "FULL") return { valid: false, reasons: ["凭证不是 FULL 模式"] };
  const current = collectAttestationState(root);
  const labels = {
    gitHead: "Git HEAD",
    gitBranch: "当前分支",
    workingTreeClean: "工作区干净状态",
    packageLockHash: "package-lock.json",
    packageJsonHash: "package.json",
    playwrightConfigHash: "Playwright 配置",
    testManifestHash: "正式测试集/测试清单",
    prismaMigrationHash: "Prisma migrations",
    prismaSchemaHash: "Prisma schema",
    relevantScriptsHash: "关键验证脚本",
    e2eDatabaseTemplateFingerprint: "E2E 数据库模板 fingerprint",
    nodeMajor: "Node 主版本",
    platform: "操作系统",
    architecture: "CPU 架构",
  };
  const reasons = [];
  for (const [key, label] of Object.entries(labels)) {
    if (saved[key] !== current[key]) reasons.push(`${label}已变化（凭证=${String(saved[key])}，当前=${String(current[key])}）`);
  }
  if (!current.workingTreeClean && !reasons.some((reason) => reason.startsWith("工作区"))) reasons.push("当前工作区存在未提交修改");
  return { valid: reasons.length === 0, reasons, attestation: saved, current };
}

function printValidation(validation) {
  if (!validation.valid) {
    process.stdout.write(`INVALID\nFULL凭证失效：\n${validation.reasons.map((reason) => `- ${reason}`).join("\n")}\n`);
    return;
  }
  const saved = validation.attestation;
  process.stdout.write([
    "VALID",
    "========================================",
    "检测到有效FULL验收凭证",
    "========================================",
    `验证HEAD：${saved.gitHead}`,
    `验证时间：${saved.generatedAt}`,
    `完整E2E：${saved.results.e2ePassed}/${saved.results.e2eTotal}`,
    `单元测试：${saved.results.unitTests.passed}/${saved.results.unitTests.total}`,
    `Build：${saved.results.productionBuild}`,
    "HEAD一致；依赖一致；Migration一致；测试集一致；工作区干净。",
    "当前源码与验收状态完全一致，可跳过重复FULL测试。",
    "",
  ].join("\n"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const validation = validateFullGateAttestation();
  printValidation(validation);
  if (!validation.valid) process.exitCode = 1;
}

export { printValidation };
