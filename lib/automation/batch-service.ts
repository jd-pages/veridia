import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { normalizeUrl } from "@/lib/topic";
import packageJson from "@/package.json";
import { backfillMissingProcessingFailureResults } from "@/lib/processing-failure-result";

export interface AutomaticTaskInput {
  url: string;
  originalInput?: string | null;
  productId: string;
  campaignId: string;
  productStage?: string | null;
  milkType?: string | null;
  notes?: string | null;
  source?: string;
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
      notes: task.notes?.trim() || null,
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
) {
  const count = (status: string) => counts.get(status) || 0;
  const waiting = count("PENDING");
  const processing = count("PROCESSING");
  const succeeded = count("COMPLETED");
  const readFailed = count("READ_FAILED");
  const failed = count("FAILED") + readFailed;
  const loginExpired = count("LOGIN_EXPIRED");
  const needsReview = count("NEEDS_REVIEW");
  const cancelled = count("CANCELLED");
  const completed = succeeded + failed + needsReview + cancelled;
  return {
    total: totalCount,
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
    progress:
      totalCount > 0 ? Math.round((completed / totalCount) * 100) : 0,
  };
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
  const where = requestedIds.length ? { id: { in: requestedIds } } : undefined;
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
    const grouped = ids.length
      ? await prisma.auditTask.groupBy({
          by: ["batchId", "status"],
          where: { batchId: { in: ids } },
          _count: { _all: true },
        })
      : [];
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

  return batches.map((batch) => {
    const counts = new Map<string, number>();
    for (const task of batch.tasks) {
      counts.set(task.status, (counts.get(task.status) || 0) + 1);
    }
    return {
      ...batch,
      stats: batchStats(batch.totalCount, counts),
      currentTask:
        batch.tasks.find((task) => task.id === batch.currentTaskId) || null,
    };
  });
}
