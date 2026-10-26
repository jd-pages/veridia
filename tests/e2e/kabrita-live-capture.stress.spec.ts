import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { importApprovedAuditReceipts } from "../helpers/real-audit-receipt-fixture";

interface Capture {
  row: number; noteId: string; like: number; comment: number; favorite: number; total: number;
  publishedAt: string; publishedAtSource: string; extraction: { path: string; sha256: string };
}

test("approved live 21-note capture: real counters, frozen history and amount-only 17-column download", async ({ page }, info) => {
  test.setTimeout(180_000);
  const proofPath = process.env.VERIDIA_APPROVED_LIVE_CAPTURE;
  if (!proofPath || !path.resolve(proofPath).startsWith(path.resolve(".playwright") + path.sep)) throw Error("APPROVED_LIVE_CAPTURE_REQUIRED");
  const proof = JSON.parse(fs.readFileSync(proofPath, "utf8")) as {
    status: string; sourceInputSha256: string; productionDatabaseWrites: number;
    rows: Capture[]; sourceModules: Array<{ path: string; sha256: string }>;
    captureBundle: { path: string; sha256: string };
  };
  expect(proof.status).toBe("ALL_21_REAL_CAPTURE_PASS");expect(proof.rows).toHaveLength(21);expect(proof.productionDatabaseWrites).toBe(0);
  const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  // The earlier capture proves the approved input scope. The new live read
  // below must use a bundle and module hashes of the CURRENT extractor.
  const manifestPath = process.env.VERIDIA_APPROVED_LIVE_MODULE_MANIFEST;
  if (!manifestPath || !path.resolve(manifestPath).startsWith(path.resolve(".playwright") + path.sep)) throw Error("CURRENT_CAPTURE_MODULE_MANIFEST_REQUIRED");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    databaseModuleImported: boolean; sources: Array<{ path: string; sha256: string }>;
    bundle: { path: string; sha256: string };
  };
  expect(manifest.databaseModuleImported).toBe(false);
  for (const file of manifest.sources) expect(sha(file.path)).toBe(file.sha256);
  const db = new PrismaClient({ datasourceUrl: process.env.E2E_DATABASE_URL });
  try {
    const imported = await importApprovedAuditReceipts(db);
    expect(proof.sourceInputSha256).toBe(imported.source.inputSha256);
    expect((await page.request.post("/api/auth/login", { data: { username: "admin", password: "Admin123!" } })).ok()).toBeTruthy();
    await db.automationSession.updateMany({ where: { platform: "XIAOHONGSHU" }, data: { status: "UNKNOWN" } });
    const snapshot = () => db.auditResult.findMany({ select: { id: true, ruleSnapshot: true, retentionStatus: true,
      retentionDueAt: true, extractionRecord: { select: { rawData: true } } }, orderBy: { id: "asc" } });
    const before = await snapshot();
    const campaignId = imported.source.data.campaigns[0].id;
    const candidate = { rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS", basicRewardRequired: false, baseRewardAmount: 50,
      interactionRewardTiers: [{ threshold: 10, amount: 20 }, { threshold: 40, amount: 50 }], retentionDays: 30 };
    const changed = await page.request.put(`/api/campaigns/${campaignId}`, { data: candidate });
    expect(changed.ok(), await changed.text()).toBeTruthy();
    const plans = new Map<string, { taskId: string; taskUrl: string; originalId: string }>();
    // Tasks exist before the actual live read. Never rewrite capturedAt or
    // backdate a task to get past STALE_EXTRACTION.
    for (const capture of proof.rows) {
      const original = imported.source.data.results.filter(result => {
        const old = imported.source.data.extractions.find(e => e.id === result.extractionRecordId)!;
        return JSON.parse(String(old.rawData)).noteId === capture.noteId;
      }).sort((a, b) => Number(b.auditedAt) - Number(a.auditedAt))[0];
      expect(original).toBeTruthy();
      const sourceTask = await db.auditTask.findUniqueOrThrow({ where: { id: String(original.auditTaskId) } });
      const task = await db.auditTask.create({ data: { url: sourceTask.url, normalizedUrl: sourceTask.normalizedUrl,
        productId: sourceTask.productId, campaignId, channel: sourceTask.channel, platform: sourceTask.platform,
        source: "MANUAL", status: "PENDING", storeName: sourceTask.storeName, commercePlatform: sourceTask.commercePlatform,
        notes: sourceTask.notes, replacesResultId: original.id } });
      plans.set(capture.noteId, { taskId: task.id, taskUrl: task.url, originalId: original.id });
    }
    const bundle = path.resolve(manifest.bundle.path);
    if (!bundle.startsWith(path.resolve(".playwright") + path.sep)) throw Error("LIVE_CAPTURE_BUNDLE_OUTSIDE_EVIDENCE_ROOT");
    expect(sha(bundle)).toBe(manifest.bundle.sha256);
    const collected = await promisify(execFile)(process.execPath, [bundle], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const finalLine = collected.stdout.trim().split(/\r?\n/u).at(-1)!;
    const complete = JSON.parse(finalLine) as { directory: string; status: string; closed: boolean };
    expect(complete.status).toBe("ALL_21_REAL_CAPTURE_PASS");expect(complete.closed).toBe(true);
    if (!path.resolve(complete.directory).startsWith(path.resolve(".playwright") + path.sep)) throw Error("LIVE_RESULT_OUTSIDE_EVIDENCE_ROOT");
    const actualLive = JSON.parse(fs.readFileSync(path.join(complete.directory, "receipt.json"), "utf8")) as { rows: Capture[]; sourceInputSha256: string };
    expect(actualLive.sourceInputSha256).toBe(proof.sourceInputSha256);expect(actualLive.rows).toHaveLength(21);
    await info.attach("actual capture after isolated task creation", { body: Buffer.from(JSON.stringify({
      directory: complete.directory, receiptSha256: sha(path.join(complete.directory, "receipt.json")),
      taskIds: [...plans.values()], clockRewritten: false, mock: false,
      sourceModuleManifest: manifestPath, manifestSha256: sha(manifestPath), bundleSha256: sha(bundle),
    })), contentType: "application/json" });
    const reconciliation: Array<{ row: number; noteId: string; originalId: string; resultId: string; taskUrl: string;
      like: number; comment: number; favorite: number; total: number; compliance: string; payout: number | null;
      payoutState: string; nextReviewAt: string; sourceCapture: Capture["extraction"] }> = [];
    for (const capture of actualLive.rows) {
      if (!path.resolve(capture.extraction.path).startsWith(path.resolve(".playwright") + path.sep)) throw Error("LIVE_SOURCE_OUTSIDE_EVIDENCE_ROOT");
      expect(sha(capture.extraction.path)).toBe(capture.extraction.sha256);
      const extraction = JSON.parse(fs.readFileSync(capture.extraction.path, "utf8"));
      expect(extraction.noteId).toBe(capture.noteId);expect(extraction.interactionExtractionStatus).toBe("SUCCESS");
      expect(extraction).toMatchObject({ likeCount: capture.like, commentCount: capture.comment, favoriteCount: capture.favorite });
      const plan = plans.get(capture.noteId)!;expect(plan).toBeTruthy();
      const task = await db.auditTask.findUniqueOrThrow({ where: { id: plan.taskId } });
      extraction.pageEvidence = { ...extraction.pageEvidence, customerLiveCapture: {
        kind: "REAL_PLATFORM_CAPTURE_USER_NORMAL_LOGIN_NO_MOCK", originalResultId: plan.originalId,
        sourceSha256: capture.extraction.sha256, sourceCapturedAt: extraction.extractedAt, candidateContractOnly: true,
      } };
      const response = await page.request.post(`/api/tasks/${task.id}/audit`, { data: { extraction } });
      expect(response.ok(), await response.text()).toBeTruthy();const result = (await response.json()).data;
      const details = await page.request.get(`/api/results/${result.id}`);expect(details.ok()).toBeTruthy();const detail = (await details.json()).data;
      const output = detail.presentation.kabrita;
      expect(detail).toMatchObject({ likeCount: capture.like, commentCount: capture.comment, favoriteCount: capture.favorite, interactionTotal: capture.total });
      expect(output.interactionTotal).toBe(capture.total);expect(JSON.parse(detail.ruleSnapshot)).toMatchObject(candidate);
      expect(detail.task.campaign.id).toBe(campaignId);expect(detail.presentation.consistency.status).toBe("CONSISTENT");
      const content = detail.presentation.conclusion.status;
      expect(["PASSED", "FAILED"]).toContain(content);
      const payout = content === "PASSED" ? 50 + (capture.total >= 40 ? 50 : capture.total >= 10 ? 20 : 0) : null;
      if (payout !== null) { expect(output.complianceResult).toBe("Y");expect(output.payoutAmount).toBe(payout);expect(output.payoutState).toContain("非已付款"); }
      else { expect(output.complianceResult).toMatch(/^N-/u);expect(output.payoutAmount).toBeNull(); }
      const publishedDay = new Date(Date.parse(capture.publishedAt) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const nextDay = new Date(Date.parse(publishedDay + "T00:00:00Z") + 30 * 86400000).toISOString().slice(0, 10);
      expect(output).toMatchObject({ nextReviewAt: nextDay, nextReviewEstimated: false });
      reconciliation.push({ row: capture.row, noteId: capture.noteId, originalId: plan.originalId, resultId: result.id,
        taskUrl: task.url, like: capture.like, comment: capture.comment, favorite: capture.favorite, total: capture.total,
        compliance: output.complianceResult, payout, payoutState: output.payoutState, nextReviewAt: nextDay, sourceCapture: capture.extraction });
    }
    for (const [row, total, payout] of [[2, 0, 50], [4, 1, 50], [5, 6, 50], [3, 13, 70], [8, 42, 100]]) {
      expect(reconciliation.find(item => item.row === row)).toMatchObject({ total, payout, compliance: "Y" });
    }
    const ids = reconciliation.map(row => row.resultId).join(",");
    const download = await page.request.get(`/api/results/export?format=xlsx&ids=${ids}`);expect(download.ok(), await download.text()).toBeTruthy();
    const bytes = await download.body(), file = info.outputPath("LIVE_21_NOTES_CANDIDATE_NOT_ACTIVATED.xlsx");fs.writeFileSync(file, bytes);
    await info.attach("actual live-data candidate 21-row XLSX", { path: file, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const workbook = new ExcelJS.Workbook();await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);const sheet = workbook.getWorksheet("佳贝艾特审核结果")!;
    expect(sheet.columnCount).toBe(17);expect(sheet.rowCount).toBe(22);expect(sheet.getCell("P1").value).toBe("打款金额");
    for (const record of reconciliation) {
      const row = Array.from({ length: 21 }, (_, index) => sheet.getRow(index + 2)).find(row => row.getCell(11).value === record.taskUrl)!;
      expect(row).toBeTruthy();expect(row.getCell(13).value).toBe(record.compliance);expect(row.getCell(15).value).toBe(record.total);
      expect(row.getCell(16).value).toBe(record.payout ?? record.payoutState);
      if (record.payout !== null) { expect(row.getCell(16).numFmt).toBe("0");expect(row.getCell(16).note).toContain("非已付款"); }
      expect(row.getCell(17)).toMatchObject({ type: ExcelJS.ValueType.Date, value: new Date(record.nextReviewAt + "T00:00:00Z"), numFmt: "yyyy-mm-dd" });
      await page.goto(`/results/${record.resultId}`);const panel = page.getByLabel("佳贝艾特审核与打款", { exact: true });
      await expect(panel).toContainText(`是否符合：${record.compliance}`);await expect(panel).toContainText(`互动量：${record.total}`);
      await expect(panel.getByLabel("打款金额", { exact: true })).toHaveText(`打款金额：${record.payout === null ? record.payoutState : `${record.payout} 元`}`);
      await expect(panel).toContainText(`下次审核时间：${record.nextReviewAt}`);
      if ([2, 4, 5, 3, 8].includes(record.row)) await panel.screenshot({ path: info.outputPath(`LIVE-row-${record.row}-ui.png`) });
    }
    const csvResponse = await page.request.get(`/api/results/export?format=csv&ids=${ids}`);expect(csvResponse.ok()).toBeTruthy();const csv = await csvResponse.text();
    fs.writeFileSync(info.outputPath("LIVE_21_NOTES_CANDIDATE_NOT_ACTIVATED.csv"), csv);
    for (const row of reconciliation) expect(csv).toContain(`,${row.total},${row.payout ?? row.payoutState},${row.nextReviewAt}`);
    for (const amount of [50, 70, 100]) expect(csv).not.toContain(`${amount}（`);
    for (const file of manifest.sources) expect(sha(file.path)).toBe(file.sha256);
    expect((await snapshot()).filter(row => before.some(old => old.id === row.id))).toEqual(before);
    await info.attach("live-21-business-reconciliation", { body: Buffer.from(JSON.stringify({
      source: "ACTUAL_21_LIVE_PLATFORM_CAPTURES_AFTER_USER_NORMAL_LOGIN_NO_MOCK", rows: reconciliation,
      candidateContract: candidate, formalContractActivated: false, originalSnapshotUnchanged: true, productionDatabaseWrites: 0,
      xlsxSha256: createHash("sha256").update(bytes).digest("hex"), payoutCellDisplay: "NUMBER_ONLY", retentionStatusSeparate: true,
    })), contentType: "application/json" });
  } finally { await db.$disconnect(); }
});
