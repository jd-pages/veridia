import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

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
  fs.cpSync(path.join(root, "prisma", "migrations", latest), path.join(legacyMigrations, latest), { recursive: true });
  prisma(["migrate", "deploy", "--schema", path.join(legacyRoot, "schema.prisma")], { DATABASE_URL: sqliteUrl(legacyDatabase) });
  prisma(["migrate", "status", "--schema", path.join(legacyRoot, "schema.prisma")], { DATABASE_URL: sqliteUrl(legacyDatabase) });
  process.stdout.write(`[FULL database] SQLite 旧数据库升级（${migrations.length - 1} -> ${migrations.length} migrations）：PASSED\n`);

  prisma(["validate", "--schema", path.join(root, "prisma", "schema.postgresql.prisma")], {
    POSTGRES_DATABASE_URL: "postgresql://veridia:veridia@127.0.0.1:5432/veridia?schema=public",
  });
  process.stdout.write("[FULL database] PostgreSQL Schema validate：PASSED\n");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
