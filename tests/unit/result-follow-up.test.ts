import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { createAuditIngestFixture, auditIngestExtraction } from "../helpers/audit-ingest-fixture";
import { removeTemporaryDirectoryWithRetry } from "../helpers/remove-temporary-directory";
const isolated = vi.hoisted(() => ({ db: undefined as PrismaClient | undefined }));
vi.mock("@/lib/db", () => ({ get prisma() { return isolated.db; } }));
vi.mock("server-only", () => ({}));
import { runAuditTask } from "@/lib/audit-service";
import { enqueueDueResultFollowUp } from "@/lib/automation/result-follow-up";
import { readFollowUpContract } from "@/lib/result-follow-up-contract";
import { rewardFromResultSnapshot } from "@/lib/interaction-reward";
let root: string, db: PrismaClient;
let fixture: Awaited<ReturnType<typeof createAuditIngestFixture>>;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-result-follow-up-"));
  const url = `file:${path.join(root, "isolated.db").replaceAll("\\", "/")}`;
  fs.writeFileSync(path.join(root, "isolated.db"), "");
  execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url }, stdio: "pipe", windowsHide: true, timeout: 120_000,
  });
  db = new PrismaClient({ datasourceUrl: url }); isolated.db = db;
  fixture = await createAuditIngestFixture(db);
  await db.campaign.update({ where: { id: fixture.campaign.id }, data: {
    rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS", baseRewardAmount: 50, retentionDays: 30,
    interactionRewardTiers: { create: [{ threshold: 10, amount: 20 }, { threshold: 40, amount: 50 }] },
  } });
  await db.user.create({ data: { id: "follow-up-admin", username: "follow-up-admin", passwordHash: "test-only", displayName: "isolated", role: "ADMIN" } });
}, 120_000);
afterAll(async () => {
  await db?.$disconnect(); isolated.db = undefined;
  if (root && path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith("veridia-result-follow-up-")) {
    await removeTemporaryDirectoryWithRetry(root);
  }
});
describe("separate automatic result follow-up / immutable contract", () => {
  it("missing original campaign contract never borrows October/current rules", () => {
    expect(readFollowUpContract("{}", { productId: "x", campaignId: "y", channel: "XIAOHONGSHU" })).toBeNull();
  });
  it("expired/unknown login never starts a browser, batch or platform request", async () => {
    expect(await enqueueDueResultFollowUp("follow-up-admin")).toEqual({ status: "LOGIN_RECOVERY_REQUIRED", batchId: null });
    expect(await db.auditBatch.count()).toBe(0);
  });
  it("Protected XHS_RESULT_AUTOMATIC_FOLLOW_UP：bounded supplement, frozen original contract and history survive live rule changes", async () => {
    const task = await fixture.task();
    const original = await runAuditTask(task.id, auditIngestExtraction(task, {
      publishedAt: null, likeCount: null, favoriteCount: null, commentCount: null, interactionExtractionStatus: "UNAVAILABLE",
    }), { source: "MANUAL" });
    const originalExtraction = await db.extractionRecord.findUniqueOrThrow({ where: { id: original.extractionRecordId! } });
    await db.automationSession.create({ data: { id: "xiaohongshu", platform: "XIAOHONGSHU", status: "READY", profilePath: path.join(root, "isolated-profile") } });
    const enqueued = await enqueueDueResultFollowUp("follow-up-admin");
    expect(enqueued).toMatchObject({ status: "QUEUED", originalResultId: original.id, source: "RESULT_DATA_SUPPLEMENT" });
    expect(await enqueueDueResultFollowUp("follow-up-admin")).toMatchObject({ status: "EXISTING_BATCH_PRESERVED" });
    const next = await db.auditTask.findFirstOrThrow({ where: { batchId: enqueued.batchId! } });
    await db.campaign.update({ where: { id: fixture.campaign.id }, data: { baseRewardAmount: 999, rewardMode: "LEGACY", retentionDays: 1 } });
    await db.auditBatch.update({ where: { id: enqueued.batchId! }, data: { status: "RUNNING", runEpoch: 1, currentTaskId: next.id } });
    await db.auditTask.update({ where: { id: next.id }, data: { status: "PROCESSING", claimEpoch: 1 } });
    const newResult = await runAuditTask(next.id, auditIngestExtraction(next, {
      publishedAt: "2026-09-01T02:00:00Z", publishedAtSource: "NETWORK_JSON:time",
      likeCount: 40, favoriteCount: 0, commentCount: 0, interactionExtractionStatus: "SUCCESS",
    }), { source: "RUNNER", executionLease: { batchId: enqueued.batchId!, taskId: next.id, runEpoch: 1, claimEpoch: 1 } });
    expect(JSON.parse(newResult.ruleSnapshot)).toMatchObject({ baseRewardAmount: 50, retentionDays: 30, rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS", ruleMonth: "2026-09" });
    const reward = rewardFromResultSnapshot({ ...newResult, finalContentStatus: newResult.autoStatus });
    expect(reward.baseRewardAmount! + reward.extraRewardAmount!).toBe(100);
    const old = await db.auditResult.findUniqueOrThrow({ where: { id: original.id } });
    expect(old.ruleSnapshot).toBe(original.ruleSnapshot);
    expect(old.interactionTotal).toBeNull();
    expect((await db.extractionRecord.findUniqueOrThrow({ where: { id: originalExtraction.id } })).rawData).toBe(originalExtraction.rawData);
    expect(newResult.extractionRecordId).not.toBe(original.extractionRecordId);
    const claim = await db.operationLog.findUniqueOrThrow({ where: { id: `result-follow-up:${original.id}:RESULT_DATA_SUPPLEMENT` } });
    expect(JSON.parse(claim.metadata!)).toMatchObject({ originalResultId: original.id, source: "RESULT_DATA_SUPPLEMENT", contractSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    await db.auditBatch.update({ where: { id: enqueued.batchId! }, data: { status: "COMPLETED", currentTaskId: null } });
  });
  it("a trusted manual review date never schedules a retention task, even after it is due", async () => {
    await db.campaign.update({ where: { id: fixture.campaign.id }, data: { rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS", baseRewardAmount: 50, retentionDays: 30 } });
    const task = await fixture.task();
    const publishedAt = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const result = await runAuditTask(task.id, auditIngestExtraction(task, { publishedAt, publishedAtSource: "NETWORK_JSON:time",
      likeCount: 13, commentCount: 0, favoriteCount: 0, interactionExtractionStatus: "SUCCESS" }), { source: "MANUAL" });
    expect(result.retentionStatus).toBe("PENDING");
    expect(await enqueueDueResultFollowUp("follow-up-admin")).toMatchObject({status:"NO_ELIGIBLE_RECORD"});
    // Display Q as a Beijing calendar date, but never shorten the original
    // contract's precise retention deadline or infer completed payment.
    const dueAt=new Date(result.retentionDueAt!);
    const countsBefore = { tasks: await db.auditTask.count(), batches: await db.auditBatch.count() };
    expect(await enqueueDueResultFollowUp("follow-up-admin",new Date(dueAt.getTime()-1))).toMatchObject({status:"NO_ELIGIBLE_RECORD"});
    expect(await enqueueDueResultFollowUp("follow-up-admin", dueAt)).toMatchObject({ status: "NO_ELIGIBLE_RECORD" });
    expect(await enqueueDueResultFollowUp("follow-up-admin",new Date(Date.now()+32*86_400_000))).toMatchObject({status:"NO_ELIGIBLE_RECORD"});
    expect({ tasks: await db.auditTask.count(), batches: await db.auditBatch.count() }).toEqual(countsBefore);
    expect((await db.auditResult.findUniqueOrThrow({where:{id:result.id}})).ruleSnapshot).toBe(result.ruleSnapshot);
  });

  it("an exact legacy contract with zero retention days still permits missing-data supplementation", async () => {
    const task = await fixture.task();
    await db.campaign.update({ where: { id: fixture.campaign.id }, data: {
      rewardMode: "LEGACY", baseRewardAmount: 0, retentionDays: 0, interactionRewardTiers: { deleteMany: {} },
    } });
    const original = await runAuditTask(task.id, auditIngestExtraction(task, {
      publishedAt: null, likeCount: null, commentCount: null, favoriteCount: null, interactionExtractionStatus: "UNAVAILABLE",
    }), { source: "MANUAL" });
    expect(readFollowUpContract(original.ruleSnapshot, task)).toMatchObject({ rewardMode: "LEGACY", retentionDays: 0 });
    const queued = await enqueueDueResultFollowUp("follow-up-admin");
    expect(queued).toMatchObject({ status: "QUEUED", originalResultId: original.id, source: "RESULT_DATA_SUPPLEMENT" });
    expect((await db.auditResult.findUniqueOrThrow({ where: { id: original.id } })).ruleSnapshot).toBe(original.ruleSnapshot);
    await db.auditBatch.update({ where: { id: queued.batchId! }, data: { status: "COMPLETED_WITH_ERRORS", currentTaskId: null } });
  });
  it("trusted September legacy contract can supplement missing fields without adopting October reward tiers", async () => {
    const task = await fixture.task();
    await db.campaign.update({where:{id:fixture.campaign.id},data:{rewardMode:"LEGACY",baseRewardAmount:0,retentionDays:30,interactionRewardTiers:{deleteMany:{}}}});
    const original = await runAuditTask(task.id,auditIngestExtraction(task,{
      publishedAt:null,likeCount:13,commentCount:0,favoriteCount:0,interactionExtractionStatus:"SUCCESS",
    }),{source:"MANUAL"});
    const contract=readFollowUpContract(original.ruleSnapshot,task);
    expect(contract).toMatchObject({rewardMode:"LEGACY",baseRewardAmount:0,ruleMonth:"2026-09",interactionRewardTiers:[]});
    await db.campaign.update({where:{id:fixture.campaign.id},data:{rewardMode:"CONTENT_BASE_PLUS_INTERACTION_TIERS",baseRewardAmount:50,month:"2026-10",interactionRewardTiers:{create:[{threshold:10,amount:20},{threshold:40,amount:50}]}}});
    const queued=await enqueueDueResultFollowUp("follow-up-admin");
    expect(queued).toMatchObject({status:"QUEUED",originalResultId:original.id,source:"RESULT_DATA_SUPPLEMENT"});
    const next=await db.auditTask.findFirstOrThrow({where:{batchId:queued.batchId!}});
    await db.auditBatch.update({where:{id:queued.batchId!},data:{status:"RUNNING",runEpoch:1,currentTaskId:next.id}});
    await db.auditTask.update({where:{id:next.id},data:{status:"PROCESSING",claimEpoch:1}});
    const result=await runAuditTask(next.id,auditIngestExtraction(next,{publishedAt:"2026-09-01T02:00:00Z",publishedAtSource:"NETWORK_JSON:time",
      likeCount:52,commentCount:0,favoriteCount:0,interactionExtractionStatus:"SUCCESS"}),
    {source:"RUNNER",executionLease:{batchId:queued.batchId!,taskId:next.id,runEpoch:1,claimEpoch:1}});
    expect(JSON.parse(result.ruleSnapshot)).toMatchObject({rewardMode:"LEGACY",baseRewardAmount:0,ruleMonth:"2026-09"});
    expect((await db.auditResult.findUniqueOrThrow({where:{id:original.id}})).ruleSnapshot).toBe(original.ruleSnapshot);
    await db.auditBatch.update({where:{id:queued.batchId!},data:{status:"COMPLETED",currentTaskId:null}});
  });
  it("bounded scanning advances past 100 future rows instead of starving a later missing-data result", async () => {
    const task = await fixture.task();
    const future = await runAuditTask(task.id, auditIngestExtraction(task, {
      publishedAt: new Date(Date.now() - 86_400_000).toISOString(), publishedAtSource: "NETWORK_JSON:time",
      likeCount: 13, commentCount: 0, favoriteCount: 0, interactionExtractionStatus: "SUCCESS",
    }), { source: "MANUAL" });
    const scalar = await db.auditResult.findUniqueOrThrow({ where: { id: future.id } });
    await db.auditResult.createMany({ data: Array.from({length:100}, (_, index) => ({
      ...scalar, id: `future-page-${index}`, auditedAt: new Date(index * 1_000),
    })) });
    const missingTask = await fixture.task();
    const missing = await runAuditTask(missingTask.id, auditIngestExtraction(missingTask, {
      publishedAt: null, likeCount: null, commentCount: null, favoriteCount: null, interactionExtractionStatus: "UNAVAILABLE",
    }), { source: "MANUAL" });
    expect(await enqueueDueResultFollowUp("follow-up-admin")).toMatchObject({status:"SCAN_CONTINUES"});
    expect(await enqueueDueResultFollowUp("follow-up-admin")).toMatchObject({status:"QUEUED",originalResultId:missing.id,source:"RESULT_DATA_SUPPLEMENT"});
  });
});
