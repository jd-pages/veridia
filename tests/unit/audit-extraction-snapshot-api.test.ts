import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuditIngestFixture, auditIngestExtraction } from "../helpers/audit-ingest-fixture";
import { removeTemporaryDirectoryWithRetry } from "../helpers/remove-temporary-directory";

const isolated = vi.hoisted(() => ({ db: undefined as PrismaClient | undefined }));
vi.mock("@/lib/db", () => ({ get prisma() { return isolated.db; } }));
vi.mock("@/lib/auth", () => ({ getSession: async () => ({ id: "snapshot-admin", role: "ADMIN" }) }));
vi.mock("server-only", () => ({}));
import { runAuditTask } from "@/lib/audit-service";
import { GET as resultGet } from "@/app/api/results/[id]/route";
import { recordProcessingFailureResult } from "@/lib/processing-failure-result";
import { isUnavailableNoteResult } from "@/lib/result-display";
import { auditConclusionCardLabel } from "@/lib/result-detail-presentation";

let temporaryRoot: string;
let db: PrismaClient;
let fixture: Awaited<ReturnType<typeof createAuditIngestFixture>>;
async function detail(id: string) {
  const response = await resultGet(new Request(`http://localhost/api/results/${id}`), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
  return (await response.json()).data;
}

beforeAll(async () => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-extraction-snapshot-"));
  const databaseUrl = `file:${path.join(temporaryRoot, "isolated.db").replaceAll("\\", "/")}`;
  fs.writeFileSync(path.join(temporaryRoot, "isolated.db"), "");
  execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe", windowsHide: true, timeout: 120_000,
  });
  db = new PrismaClient({ datasourceUrl: databaseUrl });
  isolated.db = db;
  fixture = await createAuditIngestFixture(db);
  await db.campaign.update({ where: { id: fixture.campaign.id }, data: { interactionRewardEnabled: true, interactionRewardThreshold: 10 } });
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  isolated.db = undefined;
  if (temporaryRoot) {
    const resolved = path.resolve(temporaryRoot);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("veridia-extraction-snapshot-")) throw new Error("拒绝清理非测试临时目录");
    await removeTemporaryDirectoryWithRetry(resolved);
  }
});

describe("HISTORICAL_EXTRACTION_IMMUTABLE API / Prisma", () => {
  it("真实审核服务和详情 API 保持八次采集、失败、superseded 与互动快照不变", async () => {
    const firstTask = await fixture.task();
    const first = await runAuditTask(firstTask.id, auditIngestExtraction(firstTask, {
      title: "原始标题 A", body: "原始正文 A，足够二十一字用于验证历史审核证据绝不能发生漂移。",
      likeCount: 0, commentCount: 4, favoriteCount: 6, interactionExtractionStatus: "SUCCESS",
    }), { source: "MANUAL" });
    expect(first.autoStatus).toBe("PASSED");
    expect(first.extractionRecordId).toBeTruthy();
    const original = await detail(first.id);
    let previousId = first.id;
    for (let index = 1; index <= 7; index += 1) {
      const task = await fixture.task({ url: firstTask.url, normalizedUrl: firstTask.url, replacesResultId: previousId });
      const failed = index === 1;
      const next = await runAuditTask(task.id, auditIngestExtraction(task, {
        title: failed ? null : `后续标题 ${index}`, body: failed ? null : "后续变更正文，新的内容不能修改第一次审核已经保存的历史证据。",
        publishedAt: failed ? null : "2026-08-02T00:00:00.000Z",
        pageStatus: failed ? "READ_FAILED" : "NORMAL", isPublic: failed ? null : true,
        topics: failed ? [] : auditIngestExtraction(task).topics,
        verifiedPlatformTopics: failed ? [] : auditIngestExtraction(task).verifiedPlatformTopics,
        likeCount: index, commentCount: 0, favoriteCount: 0, interactionExtractionStatus: "SUCCESS",
      }), { source: "MANUAL" });
      previousId = next.id;
      const historical = await detail(first.id);
      expect(historical.note).toEqual(original.note);
      expect(historical).toMatchObject({ autoStatus: "PASSED", isCurrent: false,
        likeCount: 0, commentCount: 4, favoriteCount: 6, interactionTotal: 10,
        interactionRewardThreshold: 10, interactionRewardStatus: original.interactionRewardStatus });
      expect(historical.note.extractions).toHaveLength(1);
    }
    expect(await db.extractionRecord.count({ where: { noteId: first.noteId } })).toBe(8);
    await expect(db.extractionRecord.delete({ where: { id: first.extractionRecordId! } })).rejects.toThrow();
    expect((await detail(first.id)).note).toEqual(original.note);
  });

  it("旧结果保持空绑定并明确告知证据未知，不猜测最新 extraction", async () => {
    const task = await fixture.task();
    const result = await runAuditTask(task.id, auditIngestExtraction(task), { source: "MANUAL" });
    await db.auditResult.update({ where: { id: result.id }, data: { extractionRecordId: null } });
    const legacy = await detail(result.id);
    expect(legacy).toMatchObject({ extractionRecordId: null, evidenceStatus: "LEGACY_UNAVAILABLE" });
    expect(legacy.note).toMatchObject({ body: null, title: null, publishedAt: null, topics: [], extractions: [] });
    expect(legacy.note.originalPublishedAt).toBeNull();
    expect(legacy.evidenceMessage).toContain("未绑定可确认");
    expect(await db.extractionRecord.count({ where: { auditTaskId: task.id } })).toBe(1);
  });

  it("处理失败保存当次未知证据，重复报告不修改已有结果", async () => {
    const diagnostics = {
      noteIdCandidates: [], bodyCandidates: [{ value: "未确认的正文候选" }], textHashtagCandidates: [],
      verifiedPlatformTopics: [], imageCandidates: [], body: "候选不是审核正文", publishedAt: "2026-08-01T00:00:00.000Z",
      topics: [{ displayText: "#候选不是审核话题" }], imageUrls: ["https://example.invalid/image.jpg"],
    };
    const task = await fixture.task({ status: "READ_FAILED", pageTitle: "失败现场 A", failureCode: "NETWORK_ERROR", failureEvidence: JSON.stringify(diagnostics) });
    const input = { taskId: task.id, status: "READ_FAILED" as const, failureCode: "NETWORK_ERROR", failureMessage: "合成网络失败", observedTaskUpdatedAt: task.updatedAt };
    const first = await recordProcessingFailureResult(input);
    expect(first?.extractionRecordId).toBeTruthy();
    const original = await detail(first!.id);
    expect(original).toMatchObject({ evidenceStatus: "RESULT_BOUND" });
    expect(original.note).toMatchObject({ title: "失败现场 A", body: null, publishedAt: null, pageStatus: "READ_FAILED" });
    const savedEvidence = JSON.parse(original.note.extractions[0].rawData);
    for (const key of ["noteIdCandidates", "bodyCandidates", "textHashtagCandidates", "verifiedPlatformTopics", "imageCandidates"] as const) {
      expect(savedEvidence[key]).toEqual(diagnostics[key]);
    }
    expect(savedEvidence).toMatchObject({ auditEvidenceVersion: 1, body: null, publishedAt: null, topics: [], pageEvidence: diagnostics });
    expect(savedEvidence).not.toHaveProperty("imageUrls");
    const observedAgain = await db.auditTask.update({ where: { id: task.id }, data: { pageTitle: "后来现场 B", failureEvidence: "{\"pageTitle\":\"后来现场 B\"}" } });
    const repeated = await recordProcessingFailureResult({ ...input, observedTaskUpdatedAt: observedAgain.updatedAt });
    expect(repeated?.id).toBe(first?.id);
    expect((await detail(first!.id)).note).toEqual(original.note);
    expect(await db.extractionRecord.count({ where: { auditTaskId: task.id } })).toBe(1);
  });

  it("内部失败补录不能越过恢复中的 PROCESSING 或 CANCELLED 状态", async () => {
    for (const status of ["PROCESSING", "CANCELLED"]) {
      const task = await fixture.task({ status });
      const result = await recordProcessingFailureResult({ taskId: task.id, status: "READ_FAILED", failureCode: "NETWORK_ERROR", failureMessage: "迟到补录", observedTaskUpdatedAt: task.updatedAt });
      expect(result).toBeNull();
      expect(await db.auditResult.count({ where: { auditTaskId: task.id } })).toBe(0);
      expect((await db.auditTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(status);
    }
  });

  it("内部失败补录拒绝 READ_FAILED→PROCESSING→READ_FAILED 后旧读取的 ABA 提交", async () => {
    const original = await fixture.task({ status: "READ_FAILED", failureCode: "NETWORK_ERROR", failureMessage: "旧失败" });
    const oldObservation = { taskId: original.id, status: "READ_FAILED" as const,
      failureCode: original.failureCode, failureMessage: original.failureMessage,
      observedTaskUpdatedAt: original.updatedAt };
    await db.auditTask.update({ where: { id: original.id }, data: {
      status: "PROCESSING", updatedAt: new Date(original.updatedAt.getTime() + 1),
    } });
    const current = await db.auditTask.update({ where: { id: original.id }, data: {
      status: "READ_FAILED", failureCode: "STRUCTURE_MISMATCH", failureMessage: "新失败",
      updatedAt: new Date(original.updatedAt.getTime() + 2),
    } });
    expect(await recordProcessingFailureResult(oldObservation)).toBeNull();
    expect(await db.auditResult.count({ where: { auditTaskId: original.id } })).toBe(0);
    expect(await db.extractionRecord.count({ where: { auditTaskId: original.id } })).toBe(0);
    expect(await db.auditTask.findUniqueOrThrow({ where: { id: original.id } })).toEqual(current);
    const fresh = await recordProcessingFailureResult({ taskId: current.id, status: "READ_FAILED",
      failureCode: current.failureCode, failureMessage: current.failureMessage,
      observedTaskUpdatedAt: current.updatedAt });
    expect(fresh?.extractionRecordId).toBeTruthy();
  });

  it("内部补录缺少调用方观察版本时 fail-closed", async () => {
    const task = await fixture.task({ status: "READ_FAILED", failureCode: "NETWORK_ERROR" });
    const result = await recordProcessingFailureResult({ taskId: task.id, status: "READ_FAILED",
      failureCode: "NETWORK_ERROR", failureMessage: null } as never);
    expect(result).toBeNull();
    expect(await db.auditResult.count({ where: { auditTaskId: task.id } })).toBe(0);
    expect(await db.extractionRecord.count({ where: { auditTaskId: task.id } })).toBe(0);
  });

  it("有效新 Runner 重试失败创建新版本，原失败快照不可变且旧回调拒绝", async () => {
    const batch = await db.auditBatch.create({ data: { status: "RUNNING", runEpoch: 1, totalCount: 1 } });
    const task = await fixture.task({ batchId: batch.id, status: "PROCESSING", claimEpoch: 1,
      attempts: 1, pageTitle: "第一次网络失败现场" });
    await db.auditBatch.update({ where: { id: batch.id }, data: { currentTaskId: task.id } });
    const firstLease = { batchId: batch.id, taskId: task.id, runEpoch: 1, claimEpoch: 1 };
    const first = await recordProcessingFailureResult({ taskId: task.id, status: "READ_FAILED",
      failureCode: "NETWORK_ERROR", failureMessage: "第一次网络失败", executionLease: firstLease });
    expect(first?.extractionRecordId).toBeTruthy();
    const original = await detail(first!.id);
    expect(isUnavailableNoteResult(original)).toBe(false);
    await db.$transaction([
      db.auditBatch.update({ where: { id: batch.id }, data: { status: "RUNNING", runEpoch: 2, currentTaskId: task.id } }),
      db.auditTask.update({ where: { id: task.id }, data: { status: "PROCESSING", claimEpoch: 2,
        attempts: 2, pageTitle: "小红书 - 你访问的页面不见了", pageType: "NOTE_NOT_FOUND" } }),
    ]);
    const nextLease = { batchId: batch.id, taskId: task.id, runEpoch: 2, claimEpoch: 2 };
    const secondInput = { taskId: task.id, status: "COMPLETED" as const,
      failureCode: "NOTE_NOT_FOUND", failureMessage: "笔记不存在", executionLease: nextLease };
    const second = await recordProcessingFailureResult(secondInput);
    expect(second?.id).not.toBe(first?.id);
    expect(second?.extractionRecordId).not.toBe(first?.extractionRecordId);
    const historical = await detail(first!.id);
    const current = await detail(second!.id);
    expect(historical.note).toEqual(original.note);
    expect(historical).toMatchObject({ isCurrent: false, supersededByResultId: second!.id });
    expect(historical.task).toMatchObject({ failureCode: "NETWORK_ERROR", failureMessage: "第一次网络失败", status: "READ_FAILED" });
    expect(isUnavailableNoteResult(historical)).toBe(false);
    expect(current).toMatchObject({ isCurrent: true, pageStatus: "NOTE_NOT_FOUND" });
    expect(current.task).toMatchObject({ failureCode: "NOTE_NOT_FOUND", failureMessage: "笔记不存在", status: "COMPLETED" });
    expect(isUnavailableNoteResult(current)).toBe(true);
    await expect(recordProcessingFailureResult(secondInput)).rejects.toMatchObject({ code: "STALE_RUNNER_COMPLETION" });
    expect(await db.auditResult.count({ where: { auditTaskId: task.id } })).toBe(2);
    expect(await db.extractionRecord.count({ where: { auditTaskId: task.id } })).toBe(2);
  });

  it.each(["NORMAL", "NOTE_NOT_FOUND"] as const)("同一任务后续 %s 相反页面诊断不会改变历史结论", async (pageStatus) => {
    const notFound = pageStatus === "NOTE_NOT_FOUND";
    const task = await fixture.task(notFound ? {} : {
      status: "READ_FAILED", failureCode: "NOTE_NOT_FOUND", failureMessage: "旧尝试页面不存在",
      pageTitle: "小红书 - 你访问的页面不见了", pageType: "NOTE_NOT_FOUND",
    });
    const result = await runAuditTask(task.id, auditIngestExtraction(task, {
      pageStatus,
      pageTitle: notFound ? "小红书 - 你访问的页面不见了" : "历史正常页面",
      pageType: notFound ? "NOTE_NOT_FOUND" : "NOTE_DETAIL",
      title: notFound ? null : "历史正常标题", body: notFound ? null : auditIngestExtraction(task).body,
      publishedAt: notFound ? null : "2026-08-01T00:00:00.000Z",
    }), { source: "MANUAL" });
    const before = await detail(result.id);
    expect(isUnavailableNoteResult(before)).toBe(notFound);
    await db.auditTask.update({ where: { id: task.id }, data: {
      status: notFound ? "PROCESSING" : "READ_FAILED",
      failureCode: notFound ? null : "NOTE_NOT_FOUND",
      failureMessage: notFound ? null : "页面不存在",
      pageTitle: notFound ? "后来正常页面" : "小红书 - 你访问的页面不见了",
      pageType: notFound ? "NOTE_DETAIL" : "NOTE_NOT_FOUND",
      failureEvidence: "{\"pageTitle\":\"后来诊断\"}",
    } });
    const after = await detail(result.id);
    expect(after.task).toMatchObject({
      failureCode: before.task.failureCode, failureMessage: before.task.failureMessage,
      failureEvidence: before.task.failureEvidence, pageTitle: before.task.pageTitle,
      pageType: before.task.pageType, status: before.task.status,
    });
    expect(isUnavailableNoteResult(after)).toBe(notFound);
    expect(auditConclusionCardLabel(after)).toBe(auditConclusionCardLabel(before));
    expect(after.note).toEqual(before.note);
  });
});
