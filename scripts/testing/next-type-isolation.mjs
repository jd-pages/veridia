import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const TEST_ARTIFACT_ROOT = ".playwright";
const FORMAL_ROUTES_RELATIVE_PATH = path.join(".next", "types", "routes.d.ts");

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function assertSafeTestNextDist(root, nextDistDir) {
  const testRoot = path.resolve(root, TEST_ARTIFACT_ROOT);
  const target = path.resolve(root, nextDistDir);
  if (!isInside(testRoot, target)) {
    throw new Error(`拒绝清理非测试 Next 目录：${target}`);
  }
  return target;
}

function malformedDeclaration(file) {
  if (!fs.existsSync(file)) return true;
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  return source.parseDiagnostics.length > 0;
}

export function captureFile(file) {
  return fs.existsSync(file)
    ? { existed: true, content: fs.readFileSync(file) }
    : { existed: false, content: null };
}

export function restoreFile(file, snapshot) {
  if (!snapshot?.existed) {
    fs.rmSync(file, { force: true });
    return;
  }
  const temporary = `${file}.veridia-restore-${process.pid}`;
  fs.writeFileSync(temporary, snapshot.content);
  fs.renameSync(temporary, file);
}

export function cleanupTestNextGeneratedTypes(root, nextDistDir) {
  const target = assertSafeTestNextDist(root, nextDistDir);
  const candidates = [path.join(target, "types"), path.join(target, "dev", "types")];
  const removed = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    fs.rmSync(candidate, { recursive: true, force: true });
    removed.push(path.relative(root, candidate).replaceAll(path.sep, "/"));
  }
  return removed;
}

export function cleanupKnownTestNextGeneratedTypes(root = process.cwd()) {
  const testRoot = path.join(root, TEST_ARTIFACT_ROOT);
  if (!fs.existsSync(testRoot)) return [];
  const removed = [];
  for (const item of fs.readdirSync(testRoot, { withFileTypes: true })) {
    if (!item.isDirectory() || !item.name.startsWith("next-")) continue;
    removed.push(...cleanupTestNextGeneratedTypes(root, path.join(TEST_ARTIFACT_ROOT, item.name)));
  }
  return removed;
}

export function formalNextTypesNeedGeneration(root = process.cwd()) {
  const nextEnv = path.join(root, "next-env.d.ts");
  if (!fs.existsSync(nextEnv)) return true;
  const nextEnvSource = fs.readFileSync(nextEnv, "utf8");
  if (!nextEnvSource.includes('import "./.next/types/routes.d.ts";')) return true;
  if (/\.playwright|\.next-preview-/u.test(nextEnvSource)) return true;
  return malformedDeclaration(path.join(root, FORMAL_ROUTES_RELATIVE_PATH));
}

export function e2eTsconfigPath(root = process.cwd()) {
  return path.relative(root, path.join(root, "tsconfig.e2e.json")).replaceAll(path.sep, "/");
}
