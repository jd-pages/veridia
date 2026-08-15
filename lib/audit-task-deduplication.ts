import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { normalizeUrl } from "@/lib/topic";
import { duplicateRelevantAuditTaskWhere } from "@/lib/automation/task-view";
import { isAutomaticBatchRuntimeLive } from "@/lib/automation/runtime-state";
import { duplicateReauditMetadataFromNotes } from "@/lib/import-task-metadata";

export type AuditTaskDuplicateReason = "TODAY_DUPLICATE";

export const auditTaskDuplicateMessages: Record<
  AuditTaskDuplicateReason,
  string
> = {
  TODAY_DUPLICATE: "该笔记今天已创建过审核任务，请勿重复创建。",
};

export const importedAuditTaskDuplicateMessage =
  "今日已存在相同笔记链接，已跳过。";

export interface AuditDuplicateHistoryEntry {
  taskId: string;
  batchId: string | null;
  batchName: string;
  taskStatus: string;
  createdAt: string;
  auditedAt: string | null;
  autoStatus: string | null;
  manualResult: string | null;
  manualReviewedAt: string | null;
  productName: string;
  brandName: string;
  storeName: string;
  campaignName: string;
  productStage: string;
  url: string;
}

export interface AuditDuplicateHistorySummary {
  identity: string;
  historicalCount: number;
  sourceTaskIds: string[];
  latest: AuditDuplicateHistoryEntry;
  histories: AuditDuplicateHistoryEntry[];
}

export function localNaturalDayRange(now = new Date()) {
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  );
  const end = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    0,
    0,
  );
  return { start, end };
}

function safeNormalizedUrl(value: string | null | undefined) {
  if (!value?.trim()) return "";
  try {
    return normalizeUrl(value);
  } catch {
    return value.trim();
  }
}

export function auditNoteIdentity(value: string | null | undefined) {
  const normalized = safeNormalizedUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    const hostname = url.hostname.toLocaleLowerCase();
    const noteMatch = /^\/(?:explore|discovery\/item)\/([^/?#]+)/iu.exec(
      url.pathname,
    );
    if (
      noteMatch &&
      (hostname === "xiaohongshu.com" ||
        hostname.endsWith(".xiaohongshu.com"))
    ) {
      return `xhs-note:${noteMatch[1].toLocaleLowerCase()}`;
    }
    if (
      hostname === "xhslink.com" ||
      hostname.endsWith(".xhslink.com") ||
      hostname === "xhslink.cn" ||
      hostname.endsWith(".xhslink.cn")
    ) {
      return `xhs-short:${hostname}${url.pathname.replace(/\/$/u, "")}`;
    }
    const douyinMatch = /^\/(?:video|note|share\/(?:video|note))\/([^/?#]+)/iu.exec(url.pathname);
    if (
      douyinMatch &&
      (hostname === "douyin.com" || hostname.endsWith(".douyin.com") ||
        hostname === "iesdouyin.com" || hostname.endsWith(".iesdouyin.com"))
    ) {
      return `douyin-content:${douyinMatch[1].toLocaleLowerCase()}`;
    }
    if (hostname === "v.douyin.com" || hostname.endsWith(".v.douyin.com")) {
      return `douyin-short:${hostname}${url.pathname.replace(/\/$/u, "")}`;
    }
  } catch {
    // 非标准 URL 仍可通过规范化后的原值比较。
  }
  return `url:${normalized}`;
}

export function auditTaskLinksMatch(
  inputUrl: string,
  task: {
    url: string;
    normalizedUrl: string;
    finalUrl: string | null;
  },
) {
  const inputKeys = new Set([
    safeNormalizedUrl(inputUrl),
    auditNoteIdentity(inputUrl),
  ]);
  return [task.url, task.normalizedUrl, task.finalUrl].some((value) => {
    if (!value) return false;
    return (
      inputKeys.has(safeNormalizedUrl(value)) ||
      inputKeys.has(auditNoteIdentity(value))
    );
  });
}

function candidateWhere(url: string): Prisma.AuditTaskWhereInput[] {
  const normalizedUrl = safeNormalizedUrl(url);
  const identity = auditNoteIdentity(url);
  const conditions: Prisma.AuditTaskWhereInput[] = [
    { normalizedUrl },
    { url },
    { finalUrl: url },
    { finalUrl: normalizedUrl },
  ];
  const identityValue = identity.replace(/^(?:xhs-(?:note|short)|douyin-(?:content|short)):/u, "");
  if (identity.startsWith("xhs-note:") && identityValue) {
    conditions.push(
      { url: { contains: identityValue } },
      { normalizedUrl: { contains: identityValue } },
      { finalUrl: { contains: identityValue } },
      {
        auditResults: {
          some: { note: { platformNoteId: identityValue } },
        },
      },
    );
  } else if (identity.startsWith("xhs-short:") && identityValue) {
    const path = new URL(normalizedUrl).pathname;
    conditions.push(
      { url: { contains: path } },
      { normalizedUrl: { contains: path } },
    );
  } else if (identity.startsWith("douyin-content:") && identityValue) {
    conditions.push(
      { url: { contains: identityValue } },
      { normalizedUrl: { contains: identityValue } },
      { finalUrl: { contains: identityValue } },
      {
        auditResults: {
          some: {
            note: {
              contentChannel: "DOUYIN",
              platformNoteId: identityValue,
            },
          },
        },
      },
    );
  } else if (identity.startsWith("douyin-short:") && identityValue) {
    const path = new URL(normalizedUrl).pathname;
    conditions.push(
      { url: { contains: path } },
      { normalizedUrl: { contains: path } },
    );
  }
  return conditions;
}

function duplicateCandidateBlocks(task: {
  status: string;
  batchId: string | null;
  auditResults: unknown[];
}) {
  if (task.auditResults.length > 0) return true;
  if (task.status === "PENDING") return true;
  return (
    task.status === "PROCESSING" &&
    Boolean(task.batchId && isAutomaticBatchRuntimeLive(task.batchId))
  );
}

function duplicateLookupWhere(urls: string[]): Prisma.AuditTaskWhereInput {
  const urlValues = [
    ...new Set(
      urls.flatMap((url) => [url.trim(), safeNormalizedUrl(url)]).filter(Boolean),
    ),
  ];
  const platformNoteIds = [
    ...new Set(
      urls
        .map(auditNoteIdentity)
        .filter((identity) =>
          /^(?:xhs-note|douyin-content):/u.test(identity),
        )
        .map((identity) => identity.slice(identity.indexOf(":") + 1)),
    ),
  ];
  return {
    OR: [
      { url: { in: urlValues } },
      { normalizedUrl: { in: urlValues } },
      { finalUrl: { in: urlValues } },
      ...(platformNoteIds.length
        ? [
            {
              auditResults: {
                some: {
                  note: { platformNoteId: { in: platformNoteIds } },
                },
              },
            } satisfies Prisma.AuditTaskWhereInput,
          ]
        : []),
    ],
  };
}

export async function findAuditTaskDuplicateHistories(input: {
  urls: string[];
}) {
  const matches = new Map<string, AuditDuplicateHistorySummary>();
  const urls = [...new Set(input.urls.filter((url) => url.trim()))];
  if (!urls.length) return matches;
  const candidates = await prisma.auditTask.findMany({
    where: duplicateLookupWhere(urls),
    select: {
      id: true,
      status: true,
      batchId: true,
      url: true,
      normalizedUrl: true,
      finalUrl: true,
      notes: true,
      storeName: true,
      productStage: true,
      createdAt: true,
      product: { select: { name: true, brandName: true } },
      campaign: { select: { name: true } },
      batch: { select: { name: true } },
      auditResults: {
        select: {
          id: true,
          auditedAt: true,
          autoStatus: true,
          note: {
            select: {
              contentChannel: true,
              platformNoteId: true,
              url: true,
              finalUrl: true,
            },
          },
          manualReviews: {
            select: { result: true, createdAt: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
        orderBy: { auditedAt: "desc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  const candidatesByIdentity = new Map<string, typeof candidates>();
  for (const task of candidates) {
    const identities = new Set(
      [task.url, task.normalizedUrl, task.finalUrl]
        .filter((value): value is string => Boolean(value))
        .map(auditNoteIdentity)
        .filter(Boolean),
    );
    for (const { note } of task.auditResults) {
      if (note.platformNoteId) {
        identities.add(
          `${note.contentChannel === "DOUYIN" ? "douyin-content" : "xhs-note"}:${note.platformNoteId.toLocaleLowerCase()}`,
        );
      }
      for (const value of [note.url, note.finalUrl]) {
        if (value) identities.add(auditNoteIdentity(value));
      }
    }
    for (const identity of identities) {
      const indexed = candidatesByIdentity.get(identity) || [];
      indexed.push(task);
      candidatesByIdentity.set(identity, indexed);
    }
  }
  for (const url of urls) {
    const inputIdentity = auditNoteIdentity(url);
    const histories = (candidatesByIdentity.get(inputIdentity) || [])
      .filter(
        (task) =>
          auditTaskLinksMatch(url, task) ||
          task.auditResults.some(({ note }) => {
            const platformIdentity = note.platformNoteId
              ? `${note.contentChannel === "DOUYIN" ? "douyin-content" : "xhs-note"}:${note.platformNoteId.toLocaleLowerCase()}`
              : "";
            return (
              inputIdentity === platformIdentity ||
              auditTaskLinksMatch(url, {
                url: note.url,
                normalizedUrl: note.url,
                finalUrl: note.finalUrl,
              })
            );
          }),
      )
      .flatMap<AuditDuplicateHistoryEntry>((task) => {
        const duplicateReaudit = duplicateReauditMetadataFromNotes(task.notes);
        const results = task.auditResults.length ? task.auditResults : [null];
        return results.map((result) => {
          const manual = result?.manualReviews[0];
          return {
            taskId: task.id,
            batchId: task.batchId,
            batchName: task.batch?.name || "",
            taskStatus: task.status,
            createdAt: task.createdAt.toISOString(),
            auditedAt: result?.auditedAt.toISOString() || null,
            autoStatus:
              duplicateReaudit?.automaticResult || result?.autoStatus || null,
            manualResult: manual?.result || null,
            manualReviewedAt: manual?.createdAt.toISOString() || null,
            productName: task.product.name,
            brandName: task.product.brandName,
            storeName: task.storeName || "",
            campaignName: task.campaign.name,
            productStage: task.productStage || "",
            url: task.url,
          };
        });
      })
      .sort((left, right) =>
        String(right.auditedAt || right.createdAt).localeCompare(
          String(left.auditedAt || left.createdAt),
        ),
      );
    if (!histories.length) continue;
    matches.set(url, {
      identity: inputIdentity,
      historicalCount: histories.filter((history) => history.auditedAt).length,
      sourceTaskIds: [...new Set(histories.map((history) => history.taskId))],
      latest: histories[0],
      histories,
    });
  }
  return matches;
}

export async function listAuditTaskDuplicateHistory(input: { url: string }) {
  const url = input.url.trim();
  if (!url) return [];
  const histories = await findAuditTaskDuplicateHistories({ urls: [url] });
  const summary = histories.get(url);
  return summary?.histories || [];
}

export async function findBlockingAuditTask(input: {
  url: string;
  now?: Date;
}) {
  const { start, end } = localNaturalDayRange(input.now);
  const candidates = await prisma.auditTask.findMany({
    where: {
      AND: [
        duplicateRelevantAuditTaskWhere,
        { OR: candidateWhere(input.url) },
        {
          OR: [
            { createdAt: { gte: start, lt: end } },
            {
              auditResults: {
                some: { auditedAt: { gte: start, lt: end } },
              },
            },
          ],
        },
      ],
    },
    select: {
      id: true,
      status: true,
      batchId: true,
      url: true,
      normalizedUrl: true,
      finalUrl: true,
      auditResults: {
        where: { supersededAt: null },
        select: {
          note: {
            select: {
              contentChannel: true,
              platformNoteId: true,
              url: true,
              finalUrl: true,
            },
          },
        },
        orderBy: { auditedAt: "desc" },
        take: 5,
      },
    },
    orderBy: { createdAt: "desc" },
  });
  const inputIdentity = auditNoteIdentity(input.url);
  const matching = candidates.filter(duplicateCandidateBlocks).find(
    (task) =>
      auditTaskLinksMatch(input.url, task) ||
      task.auditResults.some(({ note }) => {
        const platformIdentity = note.platformNoteId
          ? `${note.contentChannel === "DOUYIN" ? "douyin-content" : "xhs-note"}:${note.platformNoteId.toLocaleLowerCase()}`
          : "";
        return (
          inputIdentity === platformIdentity ||
          auditTaskLinksMatch(input.url, {
            url: note.url,
            normalizedUrl: note.url,
            finalUrl: note.finalUrl,
          })
        );
      }),
  );
  if (matching) {
    return {
      taskId: matching.id,
      reason: "TODAY_DUPLICATE" as const,
      message: auditTaskDuplicateMessages.TODAY_DUPLICATE,
    };
  }
  return null;
}

export async function findBlockingAuditTasks(input: {
  urls: string[];
  now?: Date;
}) {
  const matches = new Map<
    string,
    { taskId: string; reason: "TODAY_DUPLICATE"; message: string }
  >();
  if (!input.urls.length) return matches;
  const { start, end } = localNaturalDayRange(input.now);
  const candidates = await prisma.auditTask.findMany({
    where: {
      AND: [
        duplicateRelevantAuditTaskWhere,
        {
          OR: [
            { createdAt: { gte: start, lt: end } },
            {
              auditResults: {
                some: { auditedAt: { gte: start, lt: end } },
              },
            },
          ],
        },
      ],
    },
    select: {
      id: true,
      status: true,
      batchId: true,
      url: true,
      normalizedUrl: true,
      finalUrl: true,
      auditResults: {
        where: { supersededAt: null },
        select: {
          note: {
            select: {
              contentChannel: true,
              platformNoteId: true,
              url: true,
              finalUrl: true,
            },
          },
        },
        orderBy: { auditedAt: "desc" },
        take: 5,
      },
    },
    orderBy: { createdAt: "desc" },
  });
  const blockingCandidates = candidates.filter(duplicateCandidateBlocks);
  for (const url of input.urls) {
    const inputIdentity = auditNoteIdentity(url);
    const matching = blockingCandidates.find(
      (task) =>
        auditTaskLinksMatch(url, task) ||
        task.auditResults.some(({ note }) => {
          const platformIdentity = note.platformNoteId
            ? `${note.contentChannel === "DOUYIN" ? "douyin-content" : "xhs-note"}:${note.platformNoteId.toLocaleLowerCase()}`
            : "";
          return (
            inputIdentity === platformIdentity ||
            auditTaskLinksMatch(url, {
              url: note.url,
              normalizedUrl: note.url,
              finalUrl: note.finalUrl,
            })
          )
        }),
    );
    if (matching) {
      matches.set(url, {
        taskId: matching.id,
        reason: "TODAY_DUPLICATE",
        message: auditTaskDuplicateMessages.TODAY_DUPLICATE,
      });
    }
  }
  return matches;
}
