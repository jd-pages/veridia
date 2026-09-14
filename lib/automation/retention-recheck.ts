import "server-only";
import { prisma } from "@/lib/db";
import { withAuditExtractionSnapshot } from "@/lib/audit-extraction-snapshot";
import { resolveRetentionDueAt } from "@/lib/retention-status";
import { resolveRetentionBusinessClassificationIds } from "@/lib/retention-pending-resolver";
import { parseStoredStringArray } from "@/lib/stored-json";
import {
  createAutomaticBatchInTransaction,
  type AutomaticTaskInput,
} from "@/lib/automation/batch-service";
import {
  parseAutomationPlatform,
  platformFromUrl,
} from "@/lib/automation/platform";

const MAX_TIMER_DELAY_MS = 2_147_000_000;

interface RetentionRuntimeState {
  active?: boolean;
  sweep?: Promise<RetentionRecheckSweepResult>;
  timer?: ReturnType<typeof setTimeout>;
  timerDueAt?: number;
  wake?: () => void;
}

const globalRetentionRuntime = globalThis as typeof globalThis & {
  __veridiaRetentionRuntime?: RetentionRuntimeState;
};
const runtime = globalRetentionRuntime.__veridiaRetentionRuntime ??= {};

export interface RetentionRecheckSweepResult {
  inspected: number;
  eligible: number;
  createdTasks: number;
  createdBatches: number;
  nextDueAt: string | null;
}

export function configureRetentionRecheckQueueWake(wake: () => void) {
  runtime.wake = wake;
}

function clearScheduledTimer() {
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = undefined;
  runtime.timerDueAt = undefined;
}

function scheduleNextSweep(nextDueAt: Date | null) {
  if (!nextDueAt) {
    clearScheduledTimer();
    return;
  }
  const dueAt = nextDueAt.getTime();
  if (runtime.timer && runtime.timerDueAt === dueAt) return;
  clearScheduledTimer();
  runtime.timerDueAt = dueAt;
  runtime.timer = setTimeout(() => {
    runtime.timer = undefined;
    runtime.timerDueAt = undefined;
    void runRetentionRecheckSweep().then((result) => {
      if (result.createdTasks) runtime.wake?.();
    });
  }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, dueAt - Date.now())));
  runtime.timer.unref?.();
}

function groupKey(platform: string, createdBy: string | null) {
  return `${platform}:${createdBy || "SYSTEM"}`;
}

async function performSweep(now: Date): Promise<RetentionRecheckSweepResult> {
  const retentionClassification =
    await resolveRetentionBusinessClassificationIds();
  const candidates = await prisma.auditResult.findMany({
    where: {
      AND: [
        { supersededAt: null },
        { id: { in: retentionClassification.pendingIds } },
        { manualReviews: { none: { result: { in: ["PASSED", "FAILED"] } } } },
      ],
    },
    select: {
      id: true,
      auditTaskId: true,
      extractionRecordId: true,
      auditedAt: true,
      autoStatus: true,
      pageStatus: true,
      noteType: true,
      imageExtractionStatus: true,
      imageCount: true,
      retentionStatus: true,
      retentionDueAt: true,
      ruleSnapshot: true,
      note: { select: { id: true } },
      extractionRecord: true,
      task: true,
    },
  });
  const existing = candidates.length
    ? await prisma.auditTask.findMany({
        where: { replacesResultId: { in: candidates.map((item) => item.id) } },
        select: { replacesResultId: true },
      })
    : [];
  const alreadyScheduled = new Set(
    existing.map((item) => item.replacesResultId).filter(Boolean),
  );
  const due: Array<{
    resultId: string;
    dueAt: Date;
    task: (typeof candidates)[number]["task"];
    taskInput: AutomaticTaskInput;
    platform: "XIAOHONGSHU" | "DOUYIN";
  }> = [];
  let nextDueAt: Date | null = null;

  for (const candidate of candidates) {
    if (alreadyScheduled.has(candidate.id)) continue;
    const snapshot = withAuditExtractionSnapshot(candidate);
    const dueAtValue = resolveRetentionDueAt({
      retentionDueAt: candidate.retentionDueAt,
      retentionStatus: candidate.retentionStatus,
      ruleSnapshot: candidate.ruleSnapshot,
      note: snapshot.note,
      now,
    });
    if (!dueAtValue) continue;
    const dueAt = new Date(dueAtValue);
    if (dueAt.getTime() > now.getTime()) {
      if (!nextDueAt || dueAt < nextDueAt) nextDueAt = dueAt;
      continue;
    }
    const platform = parseAutomationPlatform(candidate.task.channel) ||
      parseAutomationPlatform(candidate.task.platform) ||
      platformFromUrl(candidate.task.url);
    if (!platform) continue;
    due.push({
      resultId: candidate.id,
      dueAt,
      task: candidate.task,
      platform,
      taskInput: {
        importRecordId: candidate.task.importRecordId,
        url: snapshot.note.url,
        originalInput: candidate.task.originalInput,
        productId: candidate.task.productId,
        campaignId: candidate.task.campaignId,
        productStage: candidate.task.productStage,
        milkType: candidate.task.milkType,
        source: "RETENTION_RECHECK",
        platform,
        channel: platform,
        commercePlatform: candidate.task.commercePlatform,
        storeName: candidate.task.storeName,
        storeTopicRuleId: candidate.task.storeTopicRuleId,
        matchedStoreName: candidate.task.matchedStoreName,
        expectedStoreTopic: candidate.task.expectedStoreTopic,
        expectedStoreTopics: parseStoredStringArray(candidate.task.expectedStoreTopics),
        requiredStoreTopics: parseStoredStringArray(candidate.task.requiredStoreTopics),
        storeMappingStatus: candidate.task.storeMappingStatus,
        orderNumber: candidate.task.orderNumber,
        notes: `系统到期复查公开留存；历史审核结果 ${candidate.id} 保持不变`,
        replacesResultId: candidate.id,
        queueOrder: candidate.task.queueOrder,
      },
    });
  }

  let createdTasks = 0;
  let createdBatches = 0;
  if (due.length) {
    const groups = new Map<string, typeof due>();
    for (const item of due) {
      const key = groupKey(item.platform, item.task.createdBy);
      groups.set(key, [...(groups.get(key) || []), item]);
    }
    const created = await prisma.$transaction(async (tx) => {
      const syncState = await tx.ruleSyncState.findUnique({
        where: { id: "active" },
        select: { currentVersion: true },
      });
      let taskCount = 0;
      let batchCount = 0;
      for (const items of groups.values()) {
        const resultIds = items.map((item) => item.resultId);
        const duplicates = await tx.auditTask.findMany({
          where: { replacesResultId: { in: resultIds } },
          select: { replacesResultId: true },
        });
        const duplicateIds = new Set(
          duplicates.map((item) => item.replacesResultId).filter(Boolean),
        );
        const uniqueItems = items.filter((item) => !duplicateIds.has(item.resultId));
        if (!uniqueItems.length) continue;
        await createAutomaticBatchInTransaction(
          tx,
          {
            name: `公开留存到期自动复查 ${now.toISOString()}`,
            source: "RETENTION_RECHECK",
            createdBy: uniqueItems[0].task.createdBy || undefined,
            allowQueuedBehindActive: true,
            tasks: uniqueItems.map((item) => item.taskInput),
          },
          syncState?.currentVersion || null,
        );
        taskCount += uniqueItems.length;
        batchCount += 1;
      }
      return { taskCount, batchCount };
    }, { timeout: 60_000 });
    createdTasks = created.taskCount;
    createdBatches = created.batchCount;
  }

  scheduleNextSweep(nextDueAt);
  return {
    inspected: candidates.length,
    eligible: due.length,
    createdTasks,
    createdBatches,
    nextDueAt: nextDueAt?.toISOString() || null,
  };
}

export function runRetentionRecheckSweep(now = new Date()) {
  runtime.sweep ??= performSweep(now).finally(() => {
    runtime.sweep = undefined;
  });
  return runtime.sweep;
}

export function refreshActiveRetentionRecheckWorkflow() {
  return runtime.active
    ? runRetentionRecheckSweep()
    : Promise.resolve<RetentionRecheckSweepResult>({
        inspected: 0,
        eligible: 0,
        createdTasks: 0,
        createdBatches: 0,
        nextDueAt: null,
      });
}

export function activateRetentionRecheckWorkflow() {
  runtime.active = true;
  return runRetentionRecheckSweep().then((result) => {
    if (result.createdTasks) runtime.wake?.();
    return result;
  });
}
