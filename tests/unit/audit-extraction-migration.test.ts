import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { removeTemporaryDirectoryWithRetry } from "../helpers/remove-temporary-directory";

it("A03 migration 保留旧结果和提取记录，不能以时间邻近猜测历史绑定", async () => {
  const models = (schemaPath: string) => fs.readFileSync(schemaPath, "utf8").match(/model\s+\w+\s*\{[\s\S]*?\n\}/gu);
  expect(models(path.resolve("prisma/schema.postgresql.prisma"))).toEqual(models(path.resolve("prisma/schema.prisma")));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-snapshot-migration-"));
  const isolatedPrisma = path.join(temporaryRoot, "prisma");
  const migrationRoot = path.join(isolatedPrisma, "migrations");
  fs.mkdirSync(migrationRoot, { recursive: true });
  const schema = path.join(isolatedPrisma, "schema.prisma");
  fs.copyFileSync(path.resolve("prisma/schema.prisma"), schema);
  const latest = "202609080001_audit_result_extraction_snapshot";
  for (const entry of fs.readdirSync(path.resolve("prisma/migrations"), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name < latest) fs.cpSync(path.resolve("prisma/migrations", entry.name), path.join(migrationRoot, entry.name), { recursive: true });
  }
  const databasePath = path.join(temporaryRoot, "legacy.db");
  fs.writeFileSync(databasePath, "");
  const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
  const migrate = () => execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "migrate", "deploy", "--schema", schema], {
    env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe", windowsHide: true, timeout: 120_000,
  });
  let db: PrismaClient | undefined;
  try {
    migrate();
    db = new PrismaClient({ datasourceUrl: databaseUrl });
    // Prisma raw commands target only this synthetic pre-migration database.
    await db.$executeRaw`INSERT INTO products (id,name,brandName,updatedAt) VALUES ('legacy-p','历史产品','历史品牌',CURRENT_TIMESTAMP)`;
    await db.$executeRaw`INSERT INTO campaigns (id,productId,name,month,startDate,endDate,updatedAt) VALUES ('legacy-c','legacy-p','历史活动','2026-09',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`;
    await db.$executeRaw`INSERT INTO audit_tasks (id,url,normalizedUrl,productId,campaignId,updatedAt) VALUES ('legacy-t','https://example.invalid/note','https://example.invalid/note','legacy-p','legacy-c',CURRENT_TIMESTAMP)`;
    await db.$executeRaw`INSERT INTO note_records (id,url,body,updatedAt) VALUES ('legacy-n','https://example.invalid/note','后来正文',CURRENT_TIMESTAMP)`;
    await db.$executeRaw`INSERT INTO extraction_records (id,auditTaskId,noteId,adapterName,adapterVersion,pageStatus,rawData) VALUES ('legacy-e','legacy-t','legacy-n','legacy','1','NORMAL','{"body":"旧提取"}')`;
    await db.$executeRaw`INSERT INTO audit_results (id,auditTaskId,noteId,ruleVersion,ruleSnapshot,pageStatus,bodyStatus,imageCount,imageCompliant,topicsCompliant,clickableCompliant,autoStatus) VALUES ('legacy-r','legacy-t','legacy-n',1,'{}','NORMAL','PRESENT',2,true,true,true,'PASSED')`;
    await db.$disconnect();
    fs.cpSync(path.resolve("prisma/migrations", latest), path.join(migrationRoot, latest), { recursive: true });
    migrate();
    db = new PrismaClient({ datasourceUrl: databaseUrl });
    const result = await db.auditResult.findUniqueOrThrow({ where: { id: "legacy-r" } });
    expect(result).toMatchObject({ extractionRecordId: null, autoStatus: "PASSED", imageCount: 2 });
    expect((await db.extractionRecord.findUniqueOrThrow({ where: { id: "legacy-e" } })).rawData).toBe('{"body":"旧提取"}');
    expect((await db.noteRecord.findUniqueOrThrow({ where: { id: "legacy-n" } })).body).toBe("后来正文");
    await expect(db.auditResult.update({ where: { id: result.id }, data: { extractionRecordId: "missing" } })).rejects.toThrow();
  } finally {
    await db?.$disconnect();
    const resolved = path.resolve(temporaryRoot);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("veridia-snapshot-migration-")) throw new Error("拒绝清理非测试临时目录");
    await removeTemporaryDirectoryWithRetry(resolved);
  }
}, 120_000);
