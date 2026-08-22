import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  attestationPath,
  validateFullGateAttestation,
  writeFullGateAttestation,
} from "../../scripts/testing/full-gate-attestation.mjs";
import { canonicalizeProjectPath } from "../../scripts/testing/project-path.mjs";

const roots: string[] = [];
let repositoryTemplate = "";
const passedResults = {
  mode: "FULL",
  passed: true,
  lint: "PASSED",
  typecheck: "PASSED",
  unitTests: { passed: 579, total: 579 },
  e2ePassed: 59,
  e2eTotal: 59,
  productionBuild: "PASSED",
  sqliteFreshMigration: "PASSED",
  sqliteLegacyUpgrade: "PASSED",
  postgresValidate: "PASSED",
  sensitiveScan: "PASSED",
  gitDiffCheck: "PASSED",
};

function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
}

function populateRepository(root: string) {
  const files: Record<string, string> = {
    ".gitignore": ".release-work/\n",
    "package.json": '{"name":"veridia"}\n',
    "package-lock.json": '{"lockfileVersion":3}\n',
    "playwright.config.ts": "export default {};\n",
    "prisma/schema.prisma": "datasource db { provider = \"sqlite\" url = env(\"DATABASE_URL\") }\n",
    "prisma/schema.postgresql.prisma": "datasource db { provider = \"postgresql\" url = env(\"DATABASE_URL\") }\n",
    "prisma/migrations/001/migration.sql": "CREATE TABLE sample(id TEXT);\n",
    "tests/e2e/sample.spec.ts": "test('sample', () => {});\n",
    "tests/e2e/setup-database.ts": "export {};\n",
    "tests/unit/sample.test.ts": "test('sample', () => {});\n",
    "scripts/testing/test-matrix.mjs": "export {};\n",
    "scripts/testing/e2e-database-template.mjs": "export {};\n",
    "scripts/release.mjs": "export {};\n",
    "scripts/fixed-workflow.mjs": "export {};\n",
    "scripts/sensitive-scan.mjs": "export {};\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    const output = path.join(root, relative);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, content, "utf8");
  }
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "tests@veridia.local"]);
  git(root, ["config", "user.name", "VERIDIA Tests"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"]);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-attestation-test-"));
  roots.push(root);
  fs.cpSync(repositoryTemplate, root, { recursive: true });
  return root;
}

function rewriteAttestationProjectRoot(root: string, projectRoot: string) {
  const file = attestationPath(root);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, `${JSON.stringify({ ...saved, projectRoot }, null, 2)}\n`, "utf8");
}

function windowsShortPath(value: string) {
  return execSync(`for %I in ("${value}") do @echo %~sI`, {
    shell: process.env.ComSpec || "cmd.exe",
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

beforeAll(() => {
  repositoryTemplate = fs.mkdtempSync(
    path.join(os.tmpdir(), "veridia-attestation-template-"),
  );
  populateRepository(repositoryTemplate);
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(repositoryTemplate, { recursive: true, force: true });
});

describe("FULL 门禁验收凭证", { timeout: 15_000 }, () => {
  it("相同 HEAD 且 clean tree 时有效", () => {
    const root = fixture();
    const attestation = writeFullGateAttestation(passedResults, root);
    expect(attestation.projectRoot).toBe(canonicalizeProjectPath(root));
    expect(validateFullGateAttestation(root).valid).toBe(true);
  });

  it.runIf(process.platform === "win32")("Windows path casing represents the same project root", () => {
    const root = fixture();
    writeFullGateAttestation(passedResults, root);
    rewriteAttestationProjectRoot(root, path.resolve(root).toUpperCase());
    expect(validateFullGateAttestation(root).valid).toBe(true);
  });

  it("a trailing separator represents the same project root", () => {
    const root = fixture();
    writeFullGateAttestation(passedResults, root);
    rewriteAttestationProjectRoot(root, `${path.resolve(root)}${path.sep}`);
    expect(validateFullGateAttestation(root).valid).toBe(true);
  });

  it.runIf(process.platform === "win32")("Windows 8.3 and long paths represent the same project root", () => {
    const root = fixture();
    writeFullGateAttestation(passedResults, root);
    rewriteAttestationProjectRoot(root, windowsShortPath(root));
    expect(validateFullGateAttestation(root).valid).toBe(true);
  });

  it("canonicalizes realpath aliases before comparing project roots", () => {
    const options = {
      platform: "win32" as const,
      resolve: (value: string) => value,
      realpath: (value: string) => value.includes("RUNNER~1")
        ? "C:\\Users\\runneradmin\\repo"
        : value,
    };
    expect(canonicalizeProjectPath("C:\\Users\\RUNNER~1\\repo", options))
      .toBe(canonicalizeProjectPath("c:\\users\\runneradmin\\repo\\", options));
  });

  it("仓库搬到其他项目根后失效", () => {
    const root = fixture();
    writeFullGateAttestation(passedResults, root);
    const movedRoot = `${root}-moved`;
    fs.renameSync(root, movedRoot);
    roots.push(movedRoot);

    const validation = validateFullGateAttestation(movedRoot);
    expect(validation.valid).toBe(false);
    expect(validation.reasons.join("\n")).toContain("项目根目录");
  });

  it("HEAD 变化时失效且不能跨 commit 继承", () => {
    const root = fixture();
    writeFullGateAttestation(passedResults, root);
    fs.writeFileSync(path.join(root, "README.md"), "next\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "next"]);
    expect(validateFullGateAttestation(root).reasons.join("\n")).toContain("Git HEAD");
  });

  it.each([
    ["dirty working tree", "README.md", "dirty\n", "工作区"],
    ["package-lock 变化", "package-lock.json", "changed\n", "package-lock.json"],
    ["migration 变化", "prisma/migrations/001/migration.sql", "changed\n", "Prisma migrations"],
    ["Playwright 配置变化", "playwright.config.ts", "changed\n", "Playwright 配置"],
    ["测试清单变化", "tests/e2e/sample.spec.ts", "changed\n", "正式测试集/测试清单"],
  ])("%s 时失效", (_name, relative, content, reason) => {
    const root = fixture();
    writeFullGateAttestation(passedResults, root);
    fs.writeFileSync(path.join(root, relative), content);
    const validation = validateFullGateAttestation(root);
    expect(validation.valid).toBe(false);
    expect(validation.reasons.join("\n")).toContain(reason);
  });

  it("FULL 任一失败时拒绝生成并删除旧凭证", () => {
    const root = fixture();
    writeFullGateAttestation(passedResults, root);
    expect(() => writeFullGateAttestation({ ...passedResults, sensitiveScan: "FAILED", passed: false }, root)).toThrow();
    expect(fs.existsSync(attestationPath(root))).toBe(false);
  });

  it("日常本地 package 可复用凭证，但方案 A 正式发布始终执行 FULL", () => {
    const localWorkflow = fs.readFileSync(path.resolve("scripts/fixed-workflow.mjs"), "utf8");
    const release = fs.readFileSync(path.resolve("scripts/release.mjs"), "utf8");
    const verify = fs.readFileSync(path.resolve("scripts/testing/verify.mjs"), "utf8");
    const softwareBat = fs.readFileSync(path.resolve("发布新版.bat"), "utf8");
    const releaseWorkflow = fs.readFileSync(path.resolve(".github/workflows/veridia-release.yml"), "utf8");
    const gitignore = fs.readFileSync(path.resolve(".gitignore"), "utf8");
    expect(localWorkflow).toContain('VERIDIA_ALLOW_FULL_ATTESTATION_REUSE: "true"');
    expect(localWorkflow).toContain("withLocalPackageFileRestore");
    expect(localWorkflow).toContain('git(["status", "--porcelain"])');
    expect(release).not.toContain("validateFullGateAttestation");
    expect(release).not.toContain("VERIDIA_ALLOW_FULL_ATTESTATION_REUSE");
    expect(release).toContain('"verify:full"');
    expect(release).not.toContain("sensitive-scan.mjs");
    expect(verify).toContain('npm("Sensitive scan", ["run", "scan:sensitive"])');
    expect(softwareBat).not.toContain("VERIDIA_ALLOW_FULL_ATTESTATION_REUSE");
    expect(releaseWorkflow).toContain("npm run verify:full");
    expect(releaseWorkflow).toContain('VERIDIA_DISABLE_ATTESTATION_WRITE: "true"');
    expect(gitignore).toContain("/.release-work/");
  });
});
