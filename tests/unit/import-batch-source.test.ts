import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  buildImportBatchLabel,
  buildImportBatchSearchText,
} from "../../lib/import-batch";
import {
  buildAuditResultWhere,
  readResultQueryFilters,
} from "../../lib/result-query";
import { removeTemporaryDirectoryWithRetry } from "../helpers/remove-temporary-directory";

const root = process.cwd();
const source = (relativePath: string) =>
  readFileSync(path.join(root, relativePath), "utf8");

describe("审核结果导入批次来源", () => {
  it("读取稳定 importRecordId 并通过任务关系过滤", () => {
    const filters = readResultQueryFilters(
      new URLSearchParams("importRecordId=import-1145&status=PASSED"),
    );
    expect(filters.importRecordId).toBe("import-1145");
    expect(buildAuditResultWhere(filters)).toMatchObject({
      AND: expect.arrayContaining([
        { autoStatus: "PASSED" },
        { task: { importRecordId: "import-1145" } },
      ]),
    });
  });

  it("同名文件通过秒级导入时间和 ID 搜索文本明确区分", () => {
    const first = {
      id: "import-0810",
      fileName: "同名.xlsx",
      createdAt: "2026-08-06T00:10:26.000Z",
      validCount: 300,
      skippedCount: 0,
      creatorDisplayName: "审核员甲",
    };
    const second = { ...first, id: "import-1145", createdAt: "2026-08-06T03:45:11.000Z" };
    expect(buildImportBatchLabel(first)).not.toBe(buildImportBatchLabel(second));
    expect(buildImportBatchSearchText(second)).toContain("import-1145");
    expect(buildImportBatchSearchText(second)).toContain("审核员甲");
  });

  it("SQLite 和 PostgreSQL schema 都使用独立外键和索引", () => {
    for (const file of [
      "prisma/schema.prisma",
      "prisma/schema.postgresql.prisma",
    ]) {
      const schema = source(file);
      expect(schema).toContain("importRecordId");
      expect(schema).toMatch(/importRecord\s+ImportRecord\?/u);
      expect(schema).toContain("@@index([importRecordId])");
    }
  });

  it("历史回填只接受十秒内的一对一候选且不更新审核结果", () => {
    const migration = source(
      "prisma/migrations/202608060002_import_record_audit_source/migration.sql",
    );
    expect(migration).toContain("<= 10000");
    expect(migration).toContain("COUNT(*)");
    expect(migration).toContain("NOT EXISTS");
    expect(migration).toContain('"b"."totalCount" = "i"."validCount"');
    expect(migration).toContain('"b"."name" = (\'表格自动审核 · \' || "i"."fileName")');
    expect(migration).not.toMatch(/UPDATE\s+"audit_results"/iu);
    expect(migration).not.toMatch(/DELETE\s+FROM/iu);
  });

  it("在真实 SQLite 中只回填唯一候选并可重复执行回填语句", async () => {
    const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "veridia-import-backfill-"));
    const databaseUrl = `file:${path.join(temporaryRoot, "legacy.db").replaceAll("\\", "/")}`;
    const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js");
    const execute = (sql: string) =>
      execFileSync(
        process.execPath,
        [prismaCli, "db", "execute", "--stdin", "--url", databaseUrl],
        { cwd: root, input: sql, stdio: ["pipe", "pipe", "pipe"] },
      );
    const migration = source(
      "prisma/migrations/202608060002_import_record_audit_source/migration.sql",
    );
    execute(`
      CREATE TABLE "import_records" (
        "id" TEXT PRIMARY KEY,
        "fileName" TEXT NOT NULL,
        "importType" TEXT NOT NULL,
        "status" TEXT NOT NULL,
        "validCount" INTEGER NOT NULL,
        "createdBy" TEXT,
        "createdAt" INTEGER NOT NULL
      );
      CREATE TABLE "audit_batches" (
        "id" TEXT PRIMARY KEY,
        "name" TEXT,
        "source" TEXT NOT NULL,
        "totalCount" INTEGER NOT NULL,
        "createdBy" TEXT,
        "createdAt" INTEGER NOT NULL
      );
      CREATE TABLE "audit_tasks" (
        "id" TEXT PRIMARY KEY,
        "batchId" TEXT
      );
      INSERT INTO "import_records" VALUES
        ('i-unique', '唯一.xlsx', 'AUDIT_TASK', 'COMPLETED', 3, 'u1', 1000000),
        ('i-ambiguous-a', '同名.xlsx', 'AUDIT_TASK', 'COMPLETED', 2, 'u1', 2000000),
        ('i-ambiguous-b', '同名.xlsx', 'AUDIT_TASK', 'COMPLETED', 2, 'u1', 2000001),
        ('i-shared', '共享.xlsx', 'AUDIT_TASK', 'COMPLETED', 1, 'u1', 3000000);
      INSERT INTO "audit_batches" VALUES
        ('b-unique', '表格自动审核 · 唯一.xlsx', 'EXCEL', 3, 'u1', 1005000),
        ('b-ambiguous', '表格自动审核 · 同名.xlsx', 'EXCEL', 2, 'u1', 2000002),
        ('b-shared-a', '表格自动审核 · 共享.xlsx', 'EXCEL', 1, 'u1', 3000001),
        ('b-shared-b', '表格自动审核 · 共享.xlsx', 'EXCEL', 1, 'u1', 3000002);
      INSERT INTO "audit_tasks" VALUES
        ('t-unique', 'b-unique'),
        ('t-ambiguous', 'b-ambiguous');
    `);
    execute(migration);
    const client = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      const batches = await client.$queryRawUnsafe<
        Array<{ id: string; importRecordId: string | null }>
      >('SELECT "id", "importRecordId" FROM "audit_batches" ORDER BY "id"');
      expect(batches.find((row) => row.id === "b-unique")?.importRecordId).toBe(
        "i-unique",
      );
      expect(
        batches.filter((row) => row.id !== "b-unique").every(
          (row) => row.importRecordId === null,
        ),
      ).toBe(true);
      const tasks = await client.$queryRawUnsafe<
        Array<{ id: string; importRecordId: string | null }>
      >('SELECT "id", "importRecordId" FROM "audit_tasks" ORDER BY "id"');
      expect(tasks).toEqual([
        { id: "t-ambiguous", importRecordId: null },
        { id: "t-unique", importRecordId: "i-unique" },
      ]);
      const backfillSql = migration.slice(migration.indexOf('WITH "candidates"'));
      execute(backfillSql);
      const afterSecondRun = await client.$queryRawUnsafe<
        Array<{ id: string; importRecordId: string | null }>
      >('SELECT "id", "importRecordId" FROM "audit_batches" ORDER BY "id"');
      expect(afterSecondRun).toEqual(batches);
    } finally {
      await client.$disconnect();
      await removeTemporaryDirectoryWithRetry(temporaryRoot);
    }
  }, 30_000);

  it("正式导入先创建 ImportRecord，预检路径不创建空记录", () => {
    const route = source("app/api/import/notes/route.ts");
    const commitBlock = route.indexOf("if (commit)");
    const importCreate = route.indexOf("tx.importRecord.create", commitBlock);
    const batchCreate = route.indexOf("createAutomaticBatchInTransaction", importCreate);
    expect(commitBlock).toBeGreaterThan(-1);
    expect(importCreate).toBeGreaterThan(commitBlock);
    expect(batchCreate).toBeGreaterThan(importCreate);
    expect(route).toContain("importRecordId: importRecord.id");
  });

  it("重新审核和留存复核继承原任务导入来源", () => {
    expect(source("app/api/results/bulk/route.ts")).toContain(
      "importRecordId: result.task.importRecordId",
    );
    expect(
      source("app/api/results/[id]/retention/recheck/route.ts"),
    ).toContain("importRecordId: result.task.importRecordId");
    const batchService = source("lib/automation/batch-service.ts");
    expect(batchService).toContain(
      "importRecordId: task.importRecordId || input.importRecordId || null",
    );
  });
});
