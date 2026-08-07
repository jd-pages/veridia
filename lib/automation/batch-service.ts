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
import {
  parseAutomationPlatform,
  platformFromUrl,
} from "@/lib/automation/platform";

export interface AutomaticTaskInput {
  importRecordId?: string | null;
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
  expectedStoreTopics?: string[] | null;
  requiredStoreTopics?: string[] | null;
  storeMappingStatus?: string | null;
  orderNumber?: string | null;
  source?: string;
  replacesResultId?: string | null;
  queueOrder?: number;
}

export interface CreateAutomaticBatchInput {
  importRecordId?: string | null;
  name?: string;
  source: string;
  createdBy?: string;
  productId?: string;
  campaignId?: string;
  productStage?: string;
  intervalMs?: number;
  queueOrder?: number;
  allowQueuedBehindActive?: boolean;
  tasks: AutomaticTaskInput[];
}

export const AUTOMATIC_TASK_WRITE_CHUNK_SIZE = 50;

export function commonImportRecordId(
  tasks: ReadonlyArray<Pick<AutomaticTaskInput, "importRecordId">>,
) {
  const ids = [...new Set(tasks.map((task) => task.importRecordId).filter(Boolean))];
  return ids.length === 1 && tasks.every((task) => task.importRecordId === ids[0])
    ? ids[0]!
    : null;
}

export async function createAutomaticBatchInTransaction(
  tx: Prisma.TransactionClient,
  input: CreateAutomaticBatchInput,
  rulePackageVersion: string | null,
) {
  if (!input.tasks.length) throw new Error("没有可加入自动审核的链接");
  const platforms = [
    ...new Set(
      input.tasks.map(
        (task) =>
          parseAutomationPlatform(task.channel) ||
          parseAutomationPlatform(task.platform) ||
          platformFromUrl(task.url),
      ),
    ),
  ];
  if (platforms.some((platform) => !platform)) {
    throw new Error("存在无法识别内容平台的链接，不能创建自动审核批次");
  }
  if (platforms.length !== 1) {
    throw new Error("同一自动审核批次只能包含一个内容平台，请按小红书或抖音分别创建批次");
  }
  const batchPlatform = platforms[0]!;
  const activeBatch = input.allowQueuedBehindActive
    ? null
    : await tx.auditBatch.findFirst({
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
        select: { id: true, channel: true },
      });
  if (activeBatch) {
    console.warn("[自动审核] 已拦截第二任务启动", { activeBatchId: activeBatch.id });
    const activePlatform = parseAutomationPlatform(activeBatch.channel);
    throw new Error(
      `当前已有内容平台自动审核任务正在运行${activePlatform ? `：${activePlatform === "DOUYIN" ? "抖音" : "小红书"}` : ""}，请完成、暂停或取消当前任务后再启动新任务。`,
    );
  }
  const batch = await tx.auditBatch.create({
    data: {
      name: input.name?.trim() || null,
      importRecordId:
        input.importRecordId || commonImportRecordId(input.tasks) || null,
      productId: input.productId || null,
      campaignId: input.campaignId || null,
      productStage: input.productStage || null,
      source: input.source,
      channel: batchPlatform,
      queueOrder: Math.max(0, input.queueOrder || 0),
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
      importRecordId: task.importRecordId || input.importRecordId || null,
      url: task.url,
      originalInput: task.originalInput?.trim() || null,
      normalizedUrl: normalizeUrl(task.url),
      productId: task.productId,
      campaignId: task.campaignId,
      productStage: task.productStage || null,
      milkType: task.milkType || null,
      source: task.source || input.source,
      status: "PENDING",
      queueOrder: task.queueOrder ?? index,
      replacesResultId: task.replacesResultId || null,
      notes: task.notes?.trim() || null,
      platform: task.platform?.trim() || batchPlatform,
      channel: task.channel?.trim() || task.platform?.trim() || batchPlatform,
      commercePlatform: task.commercePlatform?.trim() || null,
      storeName: task.storeName?.trim() || null,
      storeTopicRuleId: task.storeTopicRuleId?.trim() || null,
      matchedStoreName: task.matchedStoreName?.trim() || null,
      expectedStoreTopic: task.expectedStoreTopic?.trim() || null,
      expectedStoreTopics: JSON.stringify(task.expectedStoreTopics || []),
      requiredStoreTopics: JSON.stringify(task.requiredStoreTopics || []),
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
        importRecord: { select: { id: true, fileName: true, createdAt: true } },
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
      importRecord: { select: { id: true, fileName: true, createdAt: true } },
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
