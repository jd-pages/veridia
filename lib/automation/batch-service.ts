import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { normalizeUrl } from "@/lib/topic";
import packageJson from "@/package.json";
import { backfillMissingProcessingFailureResults } from "@/lib/processing-failure-result";
import {
  buildTaskExecutionFilterWhere,
  countTaskStatuses,
  taskExecutionStatusGroups,
} from "@/lib/automation/task-execution-filter";

export interface AutomaticTaskInput {
  url: string;
  originalInput?: string | null;
  productId: string;
  campaignId: string;
  productStage?: string | null;
  milkType?: string | null;
  notes?: string | null;
  platform?: string | null;
  channel?: string | null;
  commercePlatform?: string | null;
  storeName?: string | null;
  storeTopicRuleId?: string | null;
  matchedStoreName?: string | null;
  expectedStoreTopic?: string | null;
  storeMappingStatus?: string | null;
  orderNumber?: string | null;
  source?: string;
  replacesResultId?: string | null;
}

export interface CreateAutomaticBatchInput {
  name?: string;
  source: string;
  createdBy?: string;
  productId?: string;
  campaignId?: string;
  productStage?: string;
  intervalMs?: number;
  tasks: AutomaticTaskInput[];
}

export const AUTOMATIC_TASK_WRITE_CHUNK_SIZE = 50;

export async function createAutomaticBatchInTransaction(
  tx: Prisma.TransactionClient,
  input: CreateAutomaticBatchInput,
  rulePackageVersion: string | null,
) {
  if (!input.tasks.length) throw new Error("没有可加入自动审核的链接");
  const activeBatch = await tx.auditBatch.findFirst({
    where: {
      status: {
        in: [
          "QUEUED",
          "RUNNING",
          "RESUMING",
          "LOGIN_EXPIRED",
          "SECURITY_RESTRICTED",
        ],
      },
      clearedAt: null,
    },
    select: { id: true },
  });
  if (activeBatch) {
    console.warn("[自动审核] 已拦截第二任务启动", { activeBatchId: activeBatch.id });
    throw new Error(
      "当前已有小红书自动审核任务正在运行，请完成、暂停或取消当前任务后再启动新任务。",
    );
  }
  const batch = await tx.auditBatch.create({
    data: {
      name: input.name?.trim() || null,
      productId: input.productId || null,
      campaignId: input.campaignId || null,
      productStage: input.productStage || null,
      source: input.source,
      status: "QUEUED",
      totalCount: input.tasks.length,
      intervalMs: Math.max(
        1000,
        input.intervalMs ||
          Number(process.env.AUTOMATION_INTERVAL_MS || 5000),
      ),
      createdBy: input.createdBy || null,
    },
  });
  const taskRows: Prisma.AuditTaskCreateManyInput[] = input.tasks.map(
    (task, index) => ({
      batchId: batch.id,
      url: task.url,
      originalInput: task.originalInput?.trim() || null,
      normalizedUrl: normalizeUrl(task.url),
      productId: task.productId,
      campaignId: task.campaignId,
      productStage: task.productStage || null,
      milkType: task.milkType || null,
      source: task.source || input.source,
      status: "PENDING",
      queueOrder: index,
      replacesResultId: task.replacesResultId || null,
      notes: task.notes?.trim() || null,
      platform: task.platform?.trim() || null,
      channel: task.channel?.trim() || task.platform?.trim() || null,
      commercePlatform: task.commercePlatform?.trim() || null,
      storeName: task.storeName?.trim() || null,
      storeTopicRuleId: task.storeTopicRuleId?.trim() || null,
      matchedStoreName: task.matchedStoreName?.trim() || null,
      expectedStoreTopic: task.expectedStoreTopic?.trim() || null,
      storeMappingStatus: task.storeMappingStatus?.trim() || null,
      orderNumber: task.orderNumber?.trim() || null,
      createdBy: input.createdBy || null,
      softwareVersion: packageJson.version,
      rulePackageVersion,
    }),
  );
  for (
    let offset = 0;
    offset < taskRows.length;
    offset += AUTOMATIC_TASK_WRITE_CHUNK_SIZE
  ) {
    await tx.auditTask.createMany({
      data: taskRows.slice(offset, offset + AUTOMATIC_TASK_WRITE_CHUNK_SIZE),
    });
  }
  return batch;
}

export async function createAutomaticBatch(input: CreateAutomaticBatchInput) {
  if (!input.tasks.length) throw new Error("没有可加入自动审核的链接");
  const syncState = await prisma.ruleSyncState.findUnique({
    where: { id: "active" },
    select: { currentVersion: true },
  });
  return prisma.$transaction(
    async (tx) =>
      createAutomaticBatchInTransaction(
        tx,
        input,
        syncState?.currentVersion || null,
      ),
    { timeout: 60_000 },
  );
}

export interface AutomaticBatchQuery {
  batchId?: string;
  batchIds?: string[];
  limit?: number;
  includeTasks?: boolean;
}

function batchStats(
  totalCount: number,
  counts: ReadonlyMap<string, number>,
  pendingManualReviewCount?: number,
) {
  const count = (status: string) => counts.get(status) || 0;
  const observedTotal = [...counts.values()].reduce(
    (total, value) => total + value,
    0,
  );
  const total = observedTotal || totalCount;
  const waiting = countTaskStatuses(counts, taskExecutionStatusGroups.WAITING);
  const processing = countTaskStatuses(
    counts,
    taskExecutionStatusGroups.PROCESSING,
  );
  const succeeded = countTaskStatuses(
    counts,
    taskExecutionStatusGroups.SUCCEEDED,
  );
  const readFailed = count("READ_FAILED");
  const failed = countTaskStatuses(counts, taskExecutionStatusGroups.FAILED);
  const loginExpired = count("LOGIN_EXPIRED");
  const needsReview = pendingManualReviewCount ?? count("NEEDS_REVIEW");
  const cancelled = count("CANCELLED");
  const completed = total - waiting - processing - loginExpired;
  return {
    total,
    waiting,
    processing,
    succeeded,
    failed,
    readFailed,
    loginExpired,
    needsReview,
    cancelled,
    completed,
    remaining: waiting + processing + loginExpired,
    progress: total > 0 ? Math.round((completed / total) * 100) : 0,
  };
}

async function countPendingManualReviewsByBatch(batchIds: string[]) {
  const counts = new Map<string, number>();
  if (!batchIds.length) return counts;
  const rows = await prisma.auditTask.groupBy({
    by: ["batchId"],
    where: {
      batchId: { in: batchIds },
      ...buildTaskExecutionFilterWhere("NEEDS_REVIEW"),
    },
    _count: { _all: true },
  });
  for (const row of rows) {
    if (!row.batchId) continue;
    counts.set(row.batchId, row._count._all);
  }
  return counts;
}

export async function getAutomaticBatches(
  {
    batchId,
    batchIds = [],
    limit = 20,
    includeTasks = true,
  }: AutomaticBatchQuery = {},
) {
  await backfillMissingProcessingFailureResults();
  const requestedIds = [batchId, ...batchIds].filter(
    (value): value is string => Boolean(value),
  );
  const where: Prisma.AuditBatchWhereInput = {
    clearedAt: null,
    ...(requestedIds.length ? { id: { in: requestedIds } } : {}),
  };
  const take = Math.min(Math.max(limit, 1), 50);
  if (!includeTasks) {
    const batches = await prisma.auditBatch.findMany({
      where,
      include: {
        product: { select: { id: true, code: true, name: true } },
        campaign: { select: { id: true, name: true, month: true } },
      },
      orderBy: { createdAt: "desc" },
      take,
    });
    const ids = batches.map((batch) => batch.id);
    const [grouped, pendingManualReviewCounts] = await Promise.all([
      ids.length
        ? prisma.auditTask.groupBy({
            by: ["batchId", "status"],
            where: { batchId: { in: ids } },
            _count: { _all: true },
          })
        : [],
      countPendingManualReviewsByBatch(ids),
    ]);
    const countsByBatch = new Map<string, Map<string, number>>();
    for (const group of grouped) {
      if (!group.batchId) continue;
      const counts =
        countsByBatch.get(group.batchId) || new Map<string, number>();
      counts.set(group.status, group._count._all);
      countsByBatch.set(group.batchId, counts);
    }
    const currentTaskIds = batches
      .map((batch) => batch.currentTaskId)
      .filter((value): value is string => Boolean(value));
    const currentTasks = currentTaskIds.length
      ? await prisma.auditTask.findMany({
          where: { id: { in: currentTaskIds } },
          include: {
            product: { select: { id: true, code: true, name: true } },
            campaign: { select: { id: true, name: true, month: true } },
            auditResults: {
              orderBy: { auditedAt: "desc" },
              take: 1,
              select: {
                id: true,
                autoStatus: true,
                bodyCompliant: true,
                topicsCompliant: true,
                clickableCompliant: true,
              },
            },
          },
        })
      : [];
    const currentTaskById = new Map(
      currentTasks.map((task) => [task.id, task]),
    );
    return batches.map((batch) => ({
      ...batch,
      tasks: [],
      stats: batchStats(
        batch.totalCount,
        countsByBatch.get(batch.id) || new Map(),
        pendingManualReviewCounts.get(batch.id) || 0,
      ),
      currentTask: batch.currentTaskId
        ? currentTaskById.get(batch.currentTaskId) || null
        : null,
    }));
  }
  const batches = await prisma.auditBatch.findMany({
    where,
    include: {
      product: { select: { id: true, code: true, name: true } },
      campaign: { select: { id: true, name: true, month: true } },
      tasks: {
        include: {
          product: { select: { id: true, code: true, name: true } },
          campaign: { select: { id: true, name: true, month: true } },
          auditResults: {
            orderBy: { auditedAt: "desc" },
            take: 1,
            select: {
              id: true,
              autoStatus: true,
              bodyCompliant: true,
              topicsCompliant: true,
              clickableCompliant: true,
            },
          },
        },
        orderBy: { queueOrder: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
    take,
  });
  const pendingManualReviewCounts = await countPendingManualReviewsByBatch(
    batches.map((batch) => batch.id),
  );

  return batches.map((batch) => {
    const counts = new Map<string, number>();
    for (const task of batch.tasks) {
      counts.set(task.status, (counts.get(task.status) || 0) + 1);
    }
    return {
      ...batch,
      stats: batchStats(
        batch.totalCount,
        counts,
        pendingManualReviewCounts.get(batch.id) || 0,
      ),
      currentTask:
        batch.tasks.find((task) => task.id === batch.currentTaskId) || null,
    };
  });
}
