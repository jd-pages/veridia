import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const temporaryRoot = path.join(root, ".playwright", "database-validation", randomUUID());
fs.mkdirSync(temporaryRoot, { recursive: true });

function prisma(args, environment) {
  execFileSync(process.execPath, [path.join(root, "node_modules", "prisma", "build", "index.js"), ...args], {
    cwd: root,
    env: { ...process.env, ...environment },
    stdio: "inherit",
    windowsHide: true,
  });
}

function sqliteUrl(file) {
  return `file:${file.replaceAll("\\", "/")}`;
}

try {
  const freshDatabase = path.join(temporaryRoot, "fresh.db");
  fs.writeFileSync(freshDatabase, "");
  prisma(["migrate", "deploy"], { DATABASE_URL: sqliteUrl(freshDatabase) });
  prisma(["migrate", "status"], { DATABASE_URL: sqliteUrl(freshDatabase) });
  process.stdout.write("[FULL database] SQLite 全新数据库迁移：PASSED\n");

  const legacyRoot = path.join(temporaryRoot, "legacy-prisma");
  const legacyMigrations = path.join(legacyRoot, "migrations");
  fs.mkdirSync(legacyMigrations, { recursive: true });
  fs.copyFileSync(path.join(root, "prisma", "schema.prisma"), path.join(legacyRoot, "schema.prisma"));
  const migrations = fs.readdirSync(path.join(root, "prisma", "migrations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (migrations.length < 2) throw new Error("旧数据库升级验证至少需要两个迁移");
  const latest = migrations.at(-1);
  for (const migration of migrations.slice(0, -1)) fs.cpSync(path.join(root, "prisma", "migrations", migration), path.join(legacyMigrations, migration), { recursive: true });
  const legacyDatabase = path.join(temporaryRoot, "legacy.db");
  fs.writeFileSync(legacyDatabase, "");
  prisma(["migrate", "deploy", "--schema", path.join(legacyRoot, "schema.prisma")], { DATABASE_URL: sqliteUrl(legacyDatabase) });
  const legacyFixture = new DatabaseSync(legacyDatabase);
  legacyFixture.exec("PRAGMA foreign_keys=OFF");
  legacyFixture.prepare(`
    INSERT INTO audit_batches (
      id, name, source, status, totalCount, intervalMs, currentTaskId,
      createdAt, updatedAt
    ) VALUES (?, ?, 'AUTOMATIC', 'RUNNING', 1, 5000, NULL, ?, ?)
  `).run("legacy-orphan-batch", "1.1.12 legacy orphan", new Date().toISOString(), new Date().toISOString());
  legacyFixture.prepare(`
    INSERT INTO audit_tasks (
      id, batchId, url, normalizedUrl, productId, campaignId, source,
      status, queueOrder, attempts, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, 'AUTOMATIC', 'PROCESSING', 70, 1, ?, ?)
  `).run(
    "legacy-orphan-task",
    "legacy-orphan-batch",
    "https://www.xiaohongshu.com/explore/legacy-orphan",
    "https://www.xiaohongshu.com/explore/legacy-orphan",
    "legacy-product",
    "legacy-campaign",
    new Date().toISOString(),
    new Date().toISOString(),
  );
  legacyFixture.close();
  fs.cpSync(path.join(root, "prisma", "migrations", latest), path.join(legacyMigrations, latest), { recursive: true });
  prisma(["migrate", "deploy", "--schema", path.join(legacyRoot, "schema.prisma")], { DATABASE_URL: sqliteUrl(legacyDatabase) });
  prisma(["migrate", "status", "--schema", path.join(legacyRoot, "schema.prisma")], { DATABASE_URL: sqliteUrl(legacyDatabase) });
  const migratedFixture = new DatabaseSync(legacyDatabase, { readOnly: true });
  const migratedBatch = migratedFixture.prepare(
    "SELECT status, runEpoch FROM audit_batches WHERE id = ?",
  ).get("legacy-orphan-batch");
  const migratedTask = migratedFixture.prepare(
    "SELECT status, claimEpoch FROM audit_tasks WHERE id = ?",
  ).get("legacy-orphan-task");
  migratedFixture.close();
  if (migratedBatch?.status !== "RUNNING" || migratedBatch?.runEpoch !== 0) {
    throw new Error("Legacy migration 不得改写 Batch 状态，runEpoch 必须兼容为 0");
  }
  if (migratedTask?.status !== "PROCESSING" || migratedTask?.claimEpoch !== null) {
    throw new Error("Legacy migration 不得改写 orphan Task，claimEpoch 必须兼容为 null");
  }
  process.stdout.write("[FULL database] 1.1.12 legacy orphan 状态保持不变：PASSED\n");
  process.stdout.write(`[FULL database] SQLite 旧数据库升级（${migrations.length - 1} -> ${migrations.length} migrations）：PASSED\n`);

  prisma(["validate", "--schema", path.join(root, "prisma", "schema.postgresql.prisma")], {
    POSTGRES_DATABASE_URL: "postgresql://veridia:veridia@127.0.0.1:5432/veridia?schema=public",
  });
  process.stdout.write("[FULL database] PostgreSQL Schema validate：PASSED\n");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
