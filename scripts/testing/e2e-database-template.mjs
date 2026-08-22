import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const templateRoot = path.join(root, ".playwright", "e2e-template");
const manifestPath = path.join(templateRoot, "manifest.json");
const databasePath = path.join(templateRoot, "baseline.db");
const accountKeyRoot = path.join(templateRoot, "account-signing");

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(absolute) : [absolute];
  });
}

export function e2eTemplateFingerprint(projectRoot = root) {
  const files = [
    path.join(projectRoot, "prisma", "schema.prisma"),
    path.join(projectRoot, "rules", "default-rules.json"),
    path.join(projectRoot, "tests", "e2e", "setup-database.ts"),
    ...listFiles(path.join(projectRoot, "prisma", "migrations")),
  ].sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${path.relative(projectRoot, file).replaceAll("\\", "/")}\0`);
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

function validTemplate(fingerprint) {
  if (!fs.existsSync(manifestPath) || !fs.existsSync(databasePath)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest.schemaVersion === 1 && manifest.fingerprint === fingerprint && fs.statSync(databasePath).size > 0;
  } catch {
    return false;
  }
}

export function ensureE2eDatabaseTemplate() {
  const fingerprint = e2eTemplateFingerprint();
  if (validTemplate(fingerprint)) {
    process.stdout.write(`[E2E template] HIT ${fingerprint.slice(0, 12)}（迁移/seed 未变化）\n`);
    return { databasePath, accountKeyRoot, fingerprint, reused: true };
  }
  process.stdout.write(`[E2E template] MISS ${fingerprint.slice(0, 12)}，重新执行迁移、seed 与基线校验\n`);
  fs.rmSync(templateRoot, { recursive: true, force: true });
  fs.mkdirSync(templateRoot, { recursive: true });
  const temporaryDatabase = path.join(templateRoot, `baseline-${randomUUID()}.db`);
  const environment = {
    ...process.env,
    E2E_DATABASE_URL: `file:${temporaryDatabase}`,
    E2E_ACCOUNT_KEY_ROOT: accountKeyRoot,
  };
  try {
    execFileSync(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "tests/e2e/setup-database.ts"], {
      cwd: root,
      env: environment,
      stdio: "inherit",
      windowsHide: true,
    });
    if (!fs.existsSync(temporaryDatabase) || fs.statSync(temporaryDatabase).size === 0) throw new Error("E2E 基线数据库未生成");
    fs.renameSync(temporaryDatabase, databasePath);
    fs.chmodSync(databasePath, 0o444);
    fs.writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: 1, fingerprint, generatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  } catch (error) {
    fs.rmSync(temporaryDatabase, { force: true });
    throw error;
  }
  return { databasePath, accountKeyRoot, fingerprint, reused: false };
}

export function copyE2eDatabaseForRun(runDirectory) {
  const template = ensureE2eDatabaseTemplate();
  fs.mkdirSync(runDirectory, { recursive: true });
  const target = path.join(runDirectory, "veridia-e2e.db");
  fs.copyFileSync(template.databasePath, target);
  fs.chmodSync(target, 0o600);
  return { ...template, runDatabasePath: target };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) ensureE2eDatabaseTemplate();
