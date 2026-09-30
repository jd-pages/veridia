import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { createMockNote } from "../../lib/mock-data";
import { importedTemplateMetadataFromNotes } from "../../lib/import-task-metadata";
import type { ExtractedNote } from "../../lib/types";

const exportHeaders = [
  "登记时间", "渠道", "店铺名称", "客户备注", "买家购买ID", "购买订单号", "购买时间",
  "购买罐数", "参与次数", "发布小红书账号", "小红书发布链接", "购买产品线", "是否符合",
  "客服备注", "互动量", "额外奖励金额", "下次审核时间",
];
const importHeaders = [...exportHeaders.slice(0, 12), "活动月份（必填）", "是否符合", "客服备注"];

function isolatedDatabase() {
  const datasourceUrl = process.env.E2E_DATABASE_URL?.trim();
  if (!datasourceUrl) throw new Error("10月阶梯奖励验收必须使用隔离E2E数据库");
  return new PrismaClient({ datasourceUrl });
}

test("Protected KABRITA_OCTOBER_REWARD_DECOUPLING / KABRITA_17_COLUMN_AUDIT_EXPORT / KABRITA_NEXT_REVIEW_DATE：真实Import审核与XLSX历史快照", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  expect((await page.request.post("/api/auth/login", { data: { username: "admin", password: "Admin123!" } })).ok()).toBeTruthy();
  const db = isolatedDatabase();
  const suffix = randomUUID();
  const product = await db.product.create({ data: { name: `佳贝艾特10月真实链-${suffix}`, brandName: "佳贝艾特" } });
  const campaign = await db.campaign.create({ data: {
    name: `佳贝艾特10月阶梯验收-${suffix}`, productId: product.id, month: "2026-10", year: 2026,
    contentChannel: "XIAOHONGSHU", startDate: new Date("2026-10-01T00:00:00Z"), endDate: new Date("2026-10-31T23:59:59Z"),
    minImageCount: 2, minBodyLength: 21, bodyRequired: true, publicRequired: true, retentionDays: 30,
    rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS", basicRewardRequired: true, baseRewardAmount: 50,
    products: { create: [{ productId: product.id }] }, interactionRewardTiers: { create: [
      { threshold: 10, amount: 20, sortOrder: 0 }, { threshold: 40, amount: 50, sortOrder: 1 },
    ] },
  } });
  const requiredTopic = `#佳贝10月完整链${suffix}`;
  await db.topicRule.create({ data: { scope: "CAMPAIGN", campaignId: campaign.id, brandName: "佳贝艾特", contentChannel: "XIAOHONGSHU",
    ruleType: "MUST_ALL", topic: requiredTopic, exactMatch: true, clickableRequired: true } });
  const globalRules = await db.topicRule.findMany({ where: { scope: "GLOBAL", brandName: "佳贝艾特", status: "ACTIVE", contentChannel: { in: ["XIAOHONGSHU", "ALL"] } } });
  const allowedTopics = [...globalRules.filter((rule) => rule.ruleType !== "FORBIDDEN").map((rule) => rule.topic), requiredTopic];
  const cases = [
    { key: "pass5", total: 5, content: "PASSED", extra: 0, publishedAt: "2026-10-01T02:00:00Z", next: "2026-10-31" },
    { key: "pass15", total: 15, content: "PASSED", extra: 20, publishedAt: "2026-10-15T15:30:00Z", next: "2026-11-14" },
    { key: "pass45", total: 45, content: "PASSED", extra: 50, publishedAt: "2026-10-01T15:30:00Z", next: "2026-10-31" },
    { key: "fail45", total: 45, content: "FAILED", extra: 0, publishedAt: "2026-10-01T02:00:00Z", next: "2026-10-31" },
    { key: "missing", total: 3, content: "PASSED", extra: 0, publishedAt: "2026-10-01T02:00:00Z", next: "2026-10-31" },
    { key: "manualFail", total: 45, content: "PASSED", extra: 0, publishedAt: "2026-10-01T02:00:00Z", next: "2026-10-31" },
    { key: "manualPass", total: 45, content: "FAILED", extra: 50, publishedAt: "2026-10-01T02:00:00Z", next: "2026-10-31" },
    { key: "notFound", total: null, content: "NOTE_NOT_FOUND", extra: null, publishedAt: null, next: null },
  ] as const;
  const fixtures = new Map<string, ExtractedNote>();
  let server: Server | undefined;
  let importRecordId: string | undefined;
  const batchIds: string[] = [];
  try {
    server = createServer((request, response) => {
      const key = new URL(request.url || "/", "http://127.0.0.1").searchParams.get("fixture") || "";
      const payload = fixtures.get(key);
      if (!payload) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>佳贝艾特10月隔离样本</title><main data-xhs-page-status="${payload.pageStatus}"><h1>佳贝艾特10月隔离样本</h1></main><script id="mock-extraction-data" type="application/json">${JSON.stringify(payload).replaceAll("<", "\\u003c")}</script>`);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const source = new ExcelJS.Workbook();
    const sourceSheet = source.addWorksheet("佳贝艾特客户导入");
    sourceSheet.addRow(importHeaders);
    for (const sample of cases) {
      const url = `${origin}/mock/xhs?fixture=${sample.key}&acceptance=${suffix}`;
      const note = createMockNote("passed");
      const topics = (sample.content === "FAILED" ? allowedTopics.filter((topic) => topic !== requiredTopic) : allowedTopics)
        .map((displayText) => ({ ...note.topics[0], displayText, href: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(displayText)}` }));
      fixtures.set(sample.key, { ...note, url, finalUrl: url, noteId: `october-${suffix}-${sample.key}`, body: "佳贝艾特内容审核真实完整链验证正文".repeat(8), topics,
        imageCount: 3, likeCount: sample.key === "missing" ? null : sample.total, commentCount: sample.key === "missing" ? 3 : 0,
        favoriteCount: sample.key === "missing" ? null : 0, interactionExtractionStatus: sample.key === "missing" || sample.key === "notFound" ? "UNAVAILABLE" : "SUCCESS",
        publishedAt: sample.publishedAt, publishedAtRaw: sample.publishedAt, publishedAtSource: "NETWORK_JSON:fixture.note.publish_time",
        pageStatus: sample.content === "NOTE_NOT_FOUND" ? "NOTE_NOT_FOUND" : "NORMAL", isPublic: true });
      sourceSheet.addRow(["2026-10-16 10:00:00", "京东", "佳贝艾特(Kabrita)海外专卖店", `客户备注${sample.key}`,
        `0000-${sample.key}`, `OCT-${suffix}-${sample.key}`, "2026-09-28", "02", "01", `账号${sample.key}`,
        `原分享文案 ${url}`, product.name, "2026-10", "旧源N", `客服备注${sample.key}`]);
    }
    const imported = await page.request.post("/api/import/notes", { multipart: {
      file: { name: `佳贝艾特10月完整链-${suffix}.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await source.xlsx.writeBuffer()) },
      commit: "true", skipDuplicates: "true",
    } });
    const payload = await imported.json();
    expect(imported.ok(), JSON.stringify(payload)).toBeTruthy();
    expect(payload.data).toMatchObject({ total: cases.length, validCount: cases.length, invalidCount: 0, importedCount: cases.length });
    importRecordId = payload.data.importRecordId;
    batchIds.push(...payload.data.batchIds);
    await expect.poll(() => db.auditResult.count({ where: { task: { importRecordId } } }), { timeout: 180_000 }).toBe(cases.length);
    await expect.poll(async () => (await db.auditBatch.findMany({ where: { id: { in: batchIds } } }))
      .every((batch) => ["COMPLETED", "COMPLETED_WITH_ERRORS"].includes(batch.status)), { timeout: 30_000 }).toBe(true);
    // A fixed audit date in this isolated fixture makes the distinction from
    // result-bound publication dates independent of the test's execution day.
    await db.auditResult.updateMany({ where: { task: { importRecordId } },
      data: { createdAt: new Date("2026-10-16T02:00:00Z") } });
    const results = await db.auditResult.findMany({ where: { task: { importRecordId } }, include: { task: true, extractionRecord: true, ruleResults: true } });
    const resultByKey = new Map(results.map((result) => [result.task.orderNumber!.split("-").at(-1)!, result]));
    for (const sample of cases) {
      const result = resultByKey.get(sample.key)!;
      expect(result, sample.key).toBeTruthy();
      expect(result).toMatchObject({ autoStatus: sample.content, ruleSnapshot: expect.any(String) });
      expect(JSON.parse(result.ruleSnapshot)).toMatchObject({ rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS", baseRewardAmount: 50,
        interactionRewardTiers: [{ threshold: 10, amount: 20 }, { threshold: 40, amount: 50 }] });
      expect(result.extractionRecordId).toBeTruthy();
      expect(result.ruleResults.some((rule) => rule.ruleKey === "KABRITA_BASIC_REWARD")).toBe(false);
      expect(importedTemplateMetadataFromNotes(result.task.notes)!.rawValues.activityMonth).toBe("2026-10");
    }
    const rawMissing = resultByKey.get("missing")!;
    expect(rawMissing).toMatchObject({ likeCount: null, commentCount: 3, favoriteCount: null, interactionTotal: null });
    expect(JSON.parse(rawMissing.extractionRecord!.rawData)).toMatchObject({ likeCount: null, commentCount: 3, favoriteCount: null });
    for (const [key, finalResult] of [["manualFail", "FAILED"], ["manualPass", "PASSED"]] as const) {
      expect((await page.request.post(`/api/results/${resultByKey.get(key)!.id}/review`, { data: { result: finalResult, comment: "独立人工结论验收" } })).status()).toBe(201);
    }
    const exportResponse = await page.request.get(`/api/results/export?format=xlsx&importRecordId=${importRecordId}`);
    expect(exportResponse.ok(), `正式Export状态${exportResponse.status()}`).toBeTruthy();
    const bytes = await exportResponse.body();
    const workbookPath = testInfo.outputPath("VERIDIA_1.1.41_Kabrita_October_fixture.xlsx");
    await writeFile(workbookPath, bytes);
    await testInfo.attach("Kabrita October actual API workbook", { path: workbookPath, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet("佳贝艾特审核结果")!;
    expect(workbook.worksheets).toHaveLength(4);
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(exportHeaders);
    expect(sheet.columnCount).toBe(17);
    expect(sheet.rowCount).toBe(cases.length + 1);
    for (const sample of cases) {
      const exported = Array.from({ length: cases.length }, (_, index) => sheet.getRow(index + 2))
        .find((row) => row.getCell(6).text === `OCT-${suffix}-${sample.key}`)!;
      expect(exported, sample.key).toBeTruthy();
      expect(exported.getCell(4).text).toBe(`客户备注${sample.key}`);
      expect(exported.getCell(14).text).toBe(`客服备注${sample.key}`);
      expect(exported.getCell(8).text).toBe("02");
      const conclusion = sample.key === "notFound" ? "" : sample.key === "manualFail" || sample.key === "fail45" ? "N" : "Y";
      expect(exported.getCell(13).text, sample.key).toBe(conclusion);
      expect(exported.getCell(15).value, sample.key).toBe(sample.total);
      expect(exported.getCell(16).value, sample.key).toBe(sample.extra);
      if (sample.total !== null) {
        expect(exported.getCell(15).type).toBe(ExcelJS.ValueType.Number);
        expect(exported.getCell(16).type).toBe(ExcelJS.ValueType.Number);
        expect(exported.getCell(17)).toMatchObject({ type: ExcelJS.ValueType.Date, value: new Date(`${sample.next}T00:00:00Z`) });
        const result = resultByKey.get(sample.key)!;
        const auditPlusThirty = new Date(result.createdAt);
        auditPlusThirty.setUTCDate(auditPlusThirty.getUTCDate() + 30);
        expect(exported.getCell(17).value).not.toEqual(new Date(`${auditPlusThirty.toISOString().slice(0, 10)}T00:00:00Z`));
      } else {
        expect(exported.getCell(15).type).toBe(ExcelJS.ValueType.Null);
        expect(exported.getCell(16).type).toBe(ExcelJS.ValueType.Null);
        expect(exported.getCell(17).value).toBeNull();
      }
    }
    const before = results.map(({ id, ruleSnapshot, likeCount, commentCount, favoriteCount, interactionTotal, extractionRecord }) =>
      ({ id, ruleSnapshot, likeCount, commentCount, favoriteCount, interactionTotal, rawData: extractionRecord!.rawData }));
    await db.campaign.update({ where: { id: campaign.id }, data: { baseRewardAmount: 999,
      interactionRewardTiers: { deleteMany: {}, create: [{ threshold: 20, amount: 30, sortOrder: 0 }] } } });
    await db.noteRecord.updateMany({ where: { id: { in: results.map((result) => result.noteId) } }, data: { publishedAt: new Date("2030-01-01T00:00:00Z"), body: "后来的正文" } });
    const historical = await page.request.get(`/api/results/export?format=xlsx&importRecordId=${importRecordId}`);
    expect(historical.ok()).toBeTruthy();
    const historicalWorkbook = new ExcelJS.Workbook();
    await historicalWorkbook.xlsx.load((await historical.body()) as unknown as ExcelJS.Buffer);
    expect(historicalWorkbook.getWorksheet("佳贝艾特审核结果")!.getSheetValues()).toEqual(sheet.getSheetValues());
    const after = await db.auditResult.findMany({ where: { id: { in: results.map((result) => result.id) } }, include: { extractionRecord: true } });
    expect(after.map(({ id, ruleSnapshot, likeCount, commentCount, favoriteCount, interactionTotal, extractionRecord }) =>
      ({ id, ruleSnapshot, likeCount, commentCount, favoriteCount, interactionTotal, rawData: extractionRecord!.rawData })).sort((left, right) => left.id.localeCompare(right.id)))
      .toEqual(before.sort((left, right) => left.id.localeCompare(right.id)));
    expect(await db.auditTask.count({ where: { campaignId: campaign.id } })).toBe(cases.length);
    expect(await db.auditResult.count({ where: { task: { campaignId: campaign.id }, autoStatus: "PENDING_RETENTION" } })).toBe(0);
    const evidencePath = testInfo.outputPath("kabrita-october-evidence.json");
    await writeFile(evidencePath, JSON.stringify({ productId: product.id, campaignId: campaign.id, importRecordId, batchIds,
      resultIds: Object.fromEntries([...resultByKey].map(([key, result]) => [key, result.id])), cases,
      workbookPath, workbookSha256: createHash("sha256").update(bytes).digest("hex"),
      headers: exportHeaders, columns: 17, rows: cases.length, sheets: 4, rawMissingCountsUnchanged: true,
      rewardSnapshotImmutable: true, nextReviewSchedulerCreated: false }, null, 2));
    await testInfo.attach("Kabrita October fixture evidence", { path: evidencePath, contentType: "application/json" });
  } finally {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    const tasks = await db.auditTask.findMany({ where: { campaignId: campaign.id }, select: { id: true, batchId: true } });
    const ids = tasks.map((task) => task.id);
    const results = await db.auditResult.findMany({ where: { auditTaskId: { in: ids } }, select: { id: true, noteId: true } });
    const resultIds = results.map((result) => result.id);
    const noteIds = results.map((result) => result.noteId);
    await db.manualReview.deleteMany({ where: { auditResultId: { in: resultIds } } });
    await db.ruleResult.deleteMany({ where: { auditResultId: { in: resultIds } } });
    await db.auditResult.deleteMany({ where: { id: { in: resultIds } } });
    await db.extractionRecord.deleteMany({ where: { auditTaskId: { in: ids } } });
    await db.auditTask.deleteMany({ where: { id: { in: ids } } });
    await db.auditBatch.deleteMany({ where: { id: { in: tasks.flatMap((task) => task.batchId ? [task.batchId] : []) } } });
    if (importRecordId) await db.importRecord.deleteMany({ where: { id: importRecordId } });
    await db.noteProduct.deleteMany({ where: { noteId: { in: noteIds } } });
    await db.noteRecord.deleteMany({ where: { id: { in: noteIds }, auditResults: { none: {} }, extractions: { none: {} }, noteProducts: { none: {} } } });
    await db.topicRule.deleteMany({ where: { campaignId: campaign.id } });
    await db.campaign.delete({ where: { id: campaign.id } });
    await db.product.delete({ where: { id: product.id } });
    await db.$disconnect();
  }
});
