import "server-only";
import { prisma } from "@/lib/db";
import { normalizeUrl } from "@/lib/topic";
import packageJson from "@/package.json";

export interface AutomaticTaskInput {
  url: string;
  productId: string;
  campaignId: string;
  productStage?: string | null;
  milkType?: string | null;
  notes?: string | null;
  source?: string;
}

export async function createAutomaticBatch(input: {
  name?: string;
  source: string;
  createdBy?: string;
  productId?: string;
  campaignId?: string;
  productStage?: string;
  intervalMs?: number;
  tasks: AutomaticTaskInput[];
}) {
  if (!input.tasks.length) throw new Error("没有可加入自动审核的链接");
  const syncState = await prisma.ruleSyncState.findUnique({
    where: { id: "active" },
    select: { currentVersion: true },
  });
  return prisma.$transaction(async (tx) => {
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
    for (let index = 0; index < input.tasks.length; index += 1) {
      const task = input.tasks[index];
      await tx.auditTask.create({
        data: {
          batchId: batch.id,
          url: task.url,
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
          rulePackageVersion: syncState?.currentVersion || null,
        },
      });
    }
    return batch;
  });
}

export async function getAutomaticBatches(limit = 20) {
  const batches = await prisma.auditBatch.findMany({
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
    take: limit,
  });

  return batches.map((batch) => {
    const count = (status: string) =>
      batch.tasks.filter((task) => task.status === status).length;
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
      ...batch,
      stats: {
        total: batch.totalCount,
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
          batch.totalCount > 0
            ? Math.round((completed / batch.totalCount) * 100)
            : 0,
      },
      currentTask:
        batch.tasks.find((task) => task.id === batch.currentTaskId) || null,
    };
  });
}
