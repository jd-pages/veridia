import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuditIngestFixture, auditIngestExtraction } from "../helpers/audit-ingest-fixture";
import { removeTemporaryDirectoryWithRetry } from "../helpers/remove-temporary-directory";

const isolated = vi.hoisted(() => ({ db: undefined as PrismaClient | undefined, userId: "" }));
vi.mock("@/lib/db", () => ({ get prisma() { return isolated.db; } }));
vi.mock("@/lib/auth", () => ({ getSession: async () => ({ id: isolated.userId, role: "ADMIN" }) }));
vi.mock("server-only", () => ({}));
import { runAuditTask } from "@/lib/audit-service";
import { GET as exportGet } from "@/app/api/results/export/route";
import { GET as listGet } from "@/app/api/results/route";
import { buildImportedTaskNotes } from "@/lib/import-task-metadata";
import { isUnavailableNoteResult } from "@/lib/result-display";
import { resolveAuditEvidenceFilterIds } from "@/lib/audit-evidence-query";

let temporaryRoot: string;
let db: PrismaClient;
let fixture: Awaited<ReturnType<typeof createAuditIngestFixture>>;

beforeAll(async () => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-snapshot-export-"));
  const databasePath = path.join(temporaryRoot, "isolated.db");
  fs.writeFileSync(databasePath, "");
  const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
  execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe", windowsHide: true, timeout: 120_000,
  });
  db = new PrismaClient({ datasourceUrl: databaseUrl });
  isolated.db = db;
  isolated.userId = (await db.user.create({ data: { username: "snapshot-export-admin", displayName: "导出测试管理员", passwordHash: "unused", role: "ADMIN" } })).id;
  fixture = await createAuditIngestFixture(db);
  await db.campaign.update({ where: { id: fixture.campaign.id }, data: { interactionRewardEnabled: true, interactionRewardThreshold: 10 } });
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  isolated.db = undefined;
  if (temporaryRoot) {
    const resolved = path.resolve(temporaryRoot);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("veridia-snapshot-export-")) throw new Error("拒绝清理非测试临时目录");
    await removeTemporaryDirectoryWithRetry(resolved);
  }
});

async function exported(id: string, format: "csv" | "xlsx") {
  const response = await exportGet(new Request(`http://localhost/api/results/export?ids=${id}&format=${format}`));
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Veridia-Export-Count")).toBe("1");
  if (format === "csv") {
    const lines = (await response.text()).replace(/^\uFEFF/u, "").trimEnd().split(/\r?\n/u);
    expect(lines).toHaveLength(2);
    // The synthetic fixture contains no commas or quoted strings.
    const headers = lines[0].split(",");
    const values = lines[1].split(",");
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()) as unknown as ExcelJS.Buffer);
  expect(workbook.worksheets).toHaveLength(1);
  const sheet = workbook.worksheets[0];
  expect(sheet.rowCount).toBe(2);
  const record: Record<string, ExcelJS.CellValue> = {};
  sheet.getRow(1).eachCell((cell, column) => { record[cell.text] = sheet.getRow(2).getCell(column).value; });
  return record;
}

function publishTime(record: Record<string, unknown>) {
  const key = Object.keys(record).find((header) => /^(?:发帖时间|发布时间)/u.test(header));
  expect(key).toBeTruthy();
  return record[key!];
}

async function passedResult(notes?: string) {
  const task = await fixture.task({ notes });
  const result = await runAuditTask(task.id, auditIngestExtraction(task, {
    publishedAt: "2026-08-01T00:00:00.000Z",
    likeCount: 0, commentCount: 4, favoriteCount: 6, interactionExtractionStatus: "SUCCESS",
  }), { source: "MANUAL" });
  expect(result.autoStatus).toBe("PASSED");
  return { task, result };
}

describe("历史审核导出使用当次采集证据", () => {
  it("绑定快照关键词筛选在列表与导出保持 A/B 隔离，旧任务异常不改变状态和风险", async () => {
    const task = await fixture.task();
    const first = await runAuditTask(task.id, auditIngestExtraction(task, {
      title: "原始Alpha标题", body: "原始Beta正文，保留这次采集所记录的文字内容，满足审核最低字数。",
    }), { source: "MANUAL" });
    const another = await fixture.task({ url: task.url, normalizedUrl: task.url });
    await runAuditTask(another.id, auditIngestExtraction(another, {
      title: "更新Gamma标题", body: "更新Delta正文，这些新内容只属于第二次采集，不能影响此前结果。",
    }), { source: "MANUAL" });
    await db.auditTask.update({ where: { id: task.id }, data: {
      status: "READ_FAILED", failureCode: "NOTE_NOT_FOUND", pageTitle: "你访问的页面不见了",
      failureMessage: "笔记不存在", failureEvidence: "错误页",
    } });
    const readList = async (filters: string) => {
      const response = await listGet(new Request(`http://localhost/api/results?ids=${first.id}&${filters}`));
      expect(response.status).toBe(200);
      return (await response.json()).data;
    };
    for (const keyword of ["alpha", "BETA", "原始"]) {
      const result = await readList(`keyword=${encodeURIComponent(keyword)}`);
      expect(result.items.map((item: { id: string }) => item.id)).toEqual([first.id]);
      expect(result.summary).toMatchObject({ total: 1, passed: 1, notFound: 0 });
    }
    expect((await readList("keyword=Gamma")).items).toEqual([]);
    expect((await readList("status=PASSED")).items).toHaveLength(1);
    for (const filter of ["status=NOTE_NOT_FOUND", "pageStatus=NOTE_NOT_FOUND", "riskType=NOTE_UNAVAILABLE", "status=PROCESS_FAILED"]) {
      expect((await readList(filter)).items).toEqual([]);
    }
    const matchingExport = await exportGet(new Request(`http://localhost/api/results/export?ids=${first.id}&keyword=alpha&format=csv`));
    expect(matchingExport.status).toBe(200);
    expect(matchingExport.headers.get("X-Veridia-Export-Count")).toBe("1");
    const mismatchedExport = await exportGet(new Request(`http://localhost/api/results/export?ids=${first.id}&keyword=Gamma&format=csv`));
    expect(mismatchedExport.status).toBe(404);
    expect(await mismatchedExport.json()).toMatchObject({ errorDetail: { code: "NO_EXPORT_RESULTS" } });
  });

  it("PROCESS_FAILED 只使用已保存的处理状态，关键词与状态在同一遍扫描中独立命中", async () => {
    const task = await fixture.task();
    const failure = await runAuditTask(task.id, auditIngestExtraction(task, {
      title: "失败SnapshotNeedle标题", pageStatus: "READ_FAILED", body: null,
      topics: [], verifiedPlatformTopics: [],
    }), { source: "MANUAL" });
    await db.auditTask.update({ where: { id: task.id }, data: { status: "COMPLETED", failureCode: null } });
    const ids = await resolveAuditEvidenceFilterIds({ keyword: "definitely-unmatched", includeProcessingFailures: true });
    expect(ids.keywordIds).not.toContain(failure.id);
    expect(ids.processingFailureIds).toContain(failure.id);
    const response = await listGet(new Request(`http://localhost/api/results?ids=${failure.id}&status=PROCESS_FAILED&keyword=snapshotneedle`));
    expect(response.status).toBe(200);
    expect((await response.json()).data.items.map((item: { id: string }) => item.id)).toEqual([failure.id]);
  });

  it("关键词只检查已验证正文等业务字段，损坏快照和诊断 JSON 不会命中", async () => {
    const task = await fixture.task();
    const result = await runAuditTask(task.id, auditIngestExtraction(task, {
      title: "StrictEvidenceNeedle", pageEvidence: { marker: "DiagnosticOnlyNeedle" },
    }), { source: "MANUAL" });
    expect((await resolveAuditEvidenceFilterIds({ keyword: "strictevidenceneedle" })).keywordIds).toContain(result.id);
    expect((await resolveAuditEvidenceFilterIds({ keyword: "DiagnosticOnlyNeedle" })).keywordIds).not.toContain(result.id);
    expect((await resolveAuditEvidenceFilterIds({ keyword: new URL(task.url).pathname.split("/").at(-1)! })).keywordIds).toContain(result.id);
    await db.extractionRecord.update({ where: { id: result.extractionRecordId! }, data: { rawData: "{invalid-json" } });
    const invalid = await resolveAuditEvidenceFilterIds({ keyword: "StrictEvidenceNeedle", includeProcessingFailures: true });
    expect(invalid.keywordIds).not.toContain(result.id);
    expect(invalid.processingFailureIds).not.toContain(result.id);
  });

  it("超过 500 个绑定结果分页查询无遗漏，并排除 superseded 和 legacy 结果", async () => {
    const task = await fixture.task();
    const source = await runAuditTask(task.id, auditIngestExtraction(task, { title: "分页CursorNeedle" }), { source: "MANUAL" });
    const existing = await db.auditResult.findUniqueOrThrow({ where: { id: source.id } });
    const ids = Array.from({ length: 501 }, (_, index) => `pagination-${source.id}-${String(index).padStart(3, "0")}`);
    const supersededId = `pagination-superseded-${source.id}`;
    const legacyId = `pagination-legacy-${source.id}`;
    try {
      await db.auditResult.createMany({ data: [
        ...ids.map((id) => ({ ...existing, id })),
        { ...existing, id: supersededId, supersededAt: new Date() },
        { ...existing, id: legacyId, extractionRecordId: null },
      ] });
      const found = await resolveAuditEvidenceFilterIds({ keyword: "cursorneedle" });
      const matched = new Set(found.keywordIds);
      expect(ids.filter((id) => matched.has(id))).toHaveLength(501);
      expect(matched.has(source.id)).toBe(true);
      expect(matched.has(supersededId)).toBe(false);
      expect(matched.has(legacyId)).toBe(false);
    } finally {
      await db.auditResult.deleteMany({ where: { id: { in: [...ids, supersededId, legacyId] } } });
    }
  });

  it("列表使用当前结果绑定证据且不展开 rawData，另一个任务不存在不污染此前通过项", async () => {
    const task = await fixture.task();
    const first = await runAuditTask(task.id, auditIngestExtraction(task, {
      title: "列表原始标题", publishedAt: "2026-08-01T00:00:00.000Z",
      pageEvidence: { diagnosticMarker: "SNAPSHOT_RAW_DIAGNOSTIC" },
    }), { source: "MANUAL" });
    expect(first.autoStatus).toBe("PASSED");
    const another = await fixture.task({ url: task.url, normalizedUrl: task.url });
    const failure = await runAuditTask(another.id, auditIngestExtraction(another, {
      title: "小红书 - 你访问的页面不见了", body: null, pageStatus: "NOTE_NOT_FOUND", publishedAt: null,
      topics: [], verifiedPlatformTopics: [],
    }), { source: "MANUAL" });
    expect(failure.autoStatus).toBe("NOTE_NOT_FOUND");
    expect(await db.noteRecord.findUniqueOrThrow({ where: { id: first.noteId } })).toMatchObject({ pageStatus: "NOTE_NOT_FOUND" });
    const response = await listGet(new Request(`http://localhost/api/results?ids=${first.id}`));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.items).toHaveLength(1);
    const item = payload.data.items[0];
    expect(item).toMatchObject({ id: first.id, autoStatus: "PASSED", pageStatus: "NORMAL", evidenceStatus: "RESULT_BOUND",
      note: { title: "列表原始标题", publishedAt: "2026-08-01T00:00:00.000Z", pageStatus: "NORMAL", extractions: [] } });
    expect(isUnavailableNoteResult(item)).toBe(false);
    expect(item.extractionRecord).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("rawData");
    expect(JSON.stringify(payload)).not.toContain("SNAPSHOT_RAW_DIAGNOSTIC");
  });

  it("同笔记另一当前任务失败后 CSV/XLSX 保持原发布时间与互动快照", async () => {
    const { task, result } = await passedResult();
    const otherTask = await fixture.task({ url: task.url, normalizedUrl: task.url });
    const other = await runAuditTask(otherTask.id, auditIngestExtraction(otherTask, {
      pageStatus: "READ_FAILED", body: null, title: null, publishedAt: null,
      topics: [], verifiedPlatformTopics: [], likeCount: null, commentCount: null, favoriteCount: null,
    }), { source: "MANUAL" });
    expect(other.autoStatus).toBe("READ_FAILED");
    expect(await db.auditResult.count({ where: { noteId: result.noteId, supersededAt: null } })).toBe(2);
    expect(await db.noteRecord.findUniqueOrThrow({ where: { id: result.noteId } })).toMatchObject({ publishedAt: null, pageStatus: "READ_FAILED" });
    const csv = await exported(result.id, "csv");
    expect(publishTime(csv)).toBe("2026-08-01 00:00:00");
    expect(csv).toMatchObject({ "自审": "Y", "点赞数": "0", "评论数": "4", "收藏数": "6", "互动合计": "10", "互动奖励门槛": "10" });
    const xlsx = await exported(result.id, "xlsx");
    expect(publishTime(xlsx)).toEqual(new Date("2026-08-01T00:00:00.000Z"));
    expect(xlsx).toMatchObject({ "自审": "Y", "点赞数": 0, "评论数": 4, "收藏数": 6, "互动合计": 10, "互动奖励门槛": 10 });
  });

  it("legacy 未绑定结果不导出最新笔记时间且保留已保存互动", async () => {
    const { result } = await passedResult();
    await db.auditResult.update({ where: { id: result.id }, data: { extractionRecordId: null } });
    await db.noteRecord.update({ where: { id: result.noteId }, data: { publishedAt: new Date("2026-09-08T12:34:56.000Z") } });
    const csv = await exported(result.id, "csv");
    expect(publishTime(csv)).toBe("");
    expect(csv["互动合计"]).toBe("10");
    const xlsx = await exported(result.id, "xlsx");
    expect(publishTime(xlsx)).toBeNull();
    expect(xlsx["互动合计"]).toBe(10);
  });

  it("导入登记时间优先级与模板字段保持不变，不因 legacy 证据缺失被清空", async () => {
    const { result } = await passedResult(buildImportedTaskNotes({
      publishTime: "2026-07-18 10:20:30", orderNumber: "SNAPSHOT-EXPORT-ORDER",
      templateMetadata: { templateType: "DANONE_CUSTOMER", rawValues: { productName: "原始导入产品名", productStageDetail: "2段" } },
    }));
    await db.auditResult.update({ where: { id: result.id }, data: { extractionRecordId: null } });
    const csv = await exported(result.id, "csv");
    expect(publishTime(csv)).toBe("2026-07-18 10:20:30");
    expect(csv["订单编号"]).toBe("SNAPSHOT-EXPORT-ORDER");
    expect(csv["产品系列"]).toBe("原始导入产品名");
    const xlsx = await exported(result.id, "xlsx");
    expect(publishTime(xlsx)).toEqual(new Date("2026-07-18T10:20:30.000Z"));
    expect(xlsx["订单编号"]).toBe("SNAPSHOT-EXPORT-ORDER");
  });
});
