import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const playwrightRoot = path.join(root, ".playwright");
const templateRoot = path.join(playwrightRoot, "e2e-template");

function templatePaths(candidateRoot = templateRoot) {
  return {
    root: candidateRoot,
    manifestPath: path.join(candidateRoot, "manifest.json"),
    databasePath: path.join(candidateRoot, "baseline.db"),
    accountKeyRoot: path.join(candidateRoot, "account-signing"),
  };
}

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

function validTemplate(fingerprint, candidateRoot = templateRoot) {
  const { manifestPath, databasePath, accountKeyRoot } = templatePaths(candidateRoot);
  if (!fs.existsSync(manifestPath) || !fs.existsSync(databasePath)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest.schemaVersion === 1 &&
      manifest.fingerprint === fingerprint &&
      fs.statSync(databasePath).size > 0 &&
      fs.existsSync(path.join(accountKeyRoot, "public.pem")) &&
      fs.existsSync(path.join(accountKeyRoot, "private.pem"));
  } catch {
    return false;
  }
}

function publishedTemplate(fingerprint, reused) {
  const { databasePath, accountKeyRoot } = templatePaths();
  return { databasePath, accountKeyRoot, fingerprint, reused };
}

function quarantineInvalidTemplate(fingerprint) {
  if (!fs.existsSync(templateRoot) || validTemplate(fingerprint)) return;
  const quarantineRoot = path.join(playwrightRoot, `e2e-template-invalid-${randomUUID()}`);
  try {
    fs.renameSync(templateRoot, quarantineRoot);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    if (validTemplate(fingerprint)) return;
    throw error;
  }
  fs.rmSync(quarantineRoot, { recursive: true, force: true });
}

export function ensureE2eDatabaseTemplate() {
  const fingerprint = e2eTemplateFingerprint();
  if (validTemplate(fingerprint)) {
    process.stdout.write(`[E2E template] HIT ${fingerprint.slice(0, 12)}（迁移/seed 未变化）\n`);
    return publishedTemplate(fingerprint, true);
  }
  process.stdout.write(`[E2E template] MISS ${fingerprint.slice(0, 12)}，重新执行迁移、seed 与基线校验\n`);
  fs.mkdirSync(playwrightRoot, { recursive: true });
  quarantineInvalidTemplate(fingerprint);
  const stagingRoot = path.join(playwrightRoot, `e2e-template-build-${randomUUID()}`);
  const {
    manifestPath: stagingManifest,
    databasePath: stagingDatabase,
    accountKeyRoot: stagingAccountKeys,
  } = templatePaths(stagingRoot);
  fs.mkdirSync(stagingRoot, { recursive: true });
  const environment = {
    ...process.env,
    E2E_DATABASE_URL: `file:${stagingDatabase}`,
    E2E_ACCOUNT_KEY_ROOT: stagingAccountKeys,
  };
  try {
    execFileSync(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "tests/e2e/setup-database.ts"], {
      cwd: root,
      env: environment,
      stdio: "inherit",
      windowsHide: true,
    });
    if (!fs.existsSync(stagingDatabase) || fs.statSync(stagingDatabase).size === 0) throw new Error("E2E 基线数据库未生成");
    fs.chmodSync(stagingDatabase, 0o444);
    fs.writeFileSync(stagingManifest, `${JSON.stringify({ schemaVersion: 1, fingerprint, generatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
    try {
      fs.renameSync(stagingRoot, templateRoot);
      return publishedTemplate(fingerprint, false);
    } catch (error) {
      if (validTemplate(fingerprint)) {
        process.stdout.write(`[E2E template] RACE-HIT ${fingerprint.slice(0, 12)}（复用并发已发布基线）\n`);
        return publishedTemplate(fingerprint, true);
      }
      throw error;
    }
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
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
