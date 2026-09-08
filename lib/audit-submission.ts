import type { AuditTask, Prisma } from "@prisma/client";
import type { ExtractedNote } from "@/lib/types";
import { normalizeUrl } from "@/lib/topic";
import {
  platformFromUrl,
  resolveTaskAutomationPlatform,
} from "@/lib/automation/platform";
import type { AutomaticExecutionLease } from "@/lib/automation/execution-lease";

export type AuditSubmissionOptions =
  | { source: "RUNNER"; executionLease: AutomaticExecutionLease }
  | { source: "MANUAL" | "EXTENSION"; executionLease?: never };

export class AuditSubmissionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "AuditSubmissionError";
  }
}

export const EXTERNAL_SUBMISSION_STATUSES = [
  "PENDING", "READ_FAILED", "FAILED", "LOGIN_EXPIRED", "NEEDS_REVIEW",
] as const;

function invalidIdentity(message: string): never {
  throw new AuditSubmissionError(message, "CONTENT_IDENTITY_MISMATCH", 400);
}

function noteUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { return invalidIdentity("作品链接格式无效"); }
  if (!["http:", "https:"].includes(url.protocol)) {
    return invalidIdentity("作品链接必须使用 HTTP 或 HTTPS");
  }
  return url;
}

function isMockUrl(url: URL) {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function idsFromUrl(value: string) {
  const url = noteUrl(value);
  if (isMockUrl(url)) return [];
  const platform = platformFromUrl(value);
  const match = platform === "XIAOHONGSHU"
    ? url.pathname.match(/^\/(?:explore|discovery\/item)\/([^/?#]+)/iu)
    : platform === "DOUYIN"
      ? url.pathname.match(/^\/(?:share\/)?(?:video|note)\/([^/?#]+)/iu)
      : null;
  const queryKeys = platform === "XIAOHONGSHU"
    ? ["target_note_id", "note_id", "noteId"]
    : platform === "DOUYIN" ? ["aweme_id", "item_id", "modal_id"] : [];
  return [match?.[1], ...queryKeys.map((key) => url.searchParams.get(key))]
    .filter((id): id is string => Boolean(id));
}

/** Compare content identity, not share/tracking URL spelling. Unknown short-link
 * destinations still require the submitted original URL to match this task. */
export function assertAuditContentIdentity(task: AuditTask, payload: ExtractedNote) {
  const channel = resolveTaskAutomationPlatform(task);
  if (!channel) invalidIdentity("审核任务未关联有效内容平台");
  const declared = payload.contentChannel;
  if (declared && declared !== channel) invalidIdentity("提取内容平台与任务不一致");
  const taskUrls = [...new Set([task.url, task.normalizedUrl, task.finalUrl].filter(
    (url): url is string => Boolean(url),
  ))];
  const payloadUrls = [payload.url, payload.finalUrl].filter(
    (url): url is string => Boolean(url),
  );
  for (const value of [...taskUrls, ...payloadUrls]) {
    const url = noteUrl(value);
    if (isMockUrl(url) && process.env.VERIDIA_E2E !== "true") {
      invalidIdentity("正式审核不接受本地模拟作品");
    }
    const platform = platformFromUrl(value);
    if (platform && platform !== channel) invalidIdentity("提取链接平台与任务不一致");
    if (value === payload.finalUrl && payload.pageStatus === "NORMAL" && platform !== channel) {
      invalidIdentity("正常作品的最终链接不是任务对应的内容平台");
    }
  }
  // The original evidence URL must belong to a supported content platform.
  if (platformFromUrl(payload.url) !== channel) invalidIdentity("提取来源不是任务对应的内容平台");
  const expectedIds = new Set(taskUrls.flatMap(idsFromUrl));
  const submittedIds = new Set([
    ...payloadUrls.flatMap(idsFromUrl),
    payload.noteId, payload.platformNoteId, payload.contentId,
  ].filter((id): id is string => Boolean(id)));
  if (expectedIds.size > 1 || submittedIds.size > 1) {
    invalidIdentity("提取证据中的作品身份互相矛盾");
  }
  if (expectedIds.size && submittedIds.size) {
    if (![...submittedIds].every((id) => expectedIds.has(id))) {
      invalidIdentity("提取作品 ID 与审核任务不一致");
    }
    return;
  }
  const knownUrls = new Set(taskUrls.map(normalizeUrl));
  if (!payloadUrls.some((url) => knownUrls.has(normalizeUrl(url)))) {
    invalidIdentity("提取链接未绑定当前任务，请提交原始短链或已确认的最终作品链接");
  }
}

export function assertAuditSubmission(task: AuditTask, payload: ExtractedNote, options: AuditSubmissionOptions) {
  if (!options || !["RUNNER", "MANUAL", "EXTENSION"].includes(options.source)) {
    throw new AuditSubmissionError("必须指定审核提交来源", "SUBMISSION_SOURCE_REQUIRED", 400);
  }
  if (/mock/iu.test(payload.adapterName) && process.env.VERIDIA_E2E !== "true") {
    throw new AuditSubmissionError("正式审核不接受模拟提取数据", "MOCK_EXTRACTION_DISABLED", 400);
  }
  if (options.source === "RUNNER") {
    if (!options.executionLease || options.executionLease.taskId !== task.id) {
      throw new AuditSubmissionError("自动审核提交缺少当前任务执行凭证", "INVALID_EXECUTION_LEASE");
    }
  } else if (
    options.executionLease || task.batchId || task.claimEpoch !== null ||
    !(EXTERNAL_SUBMISSION_STATUSES as readonly string[]).includes(task.status)
  ) {
    throw new AuditSubmissionError("任务当前状态不接受人工或插件结果，请通过重新审核创建新任务", "TASK_SUBMISSION_NOT_ALLOWED");
  }
  if (options.source !== "RUNNER" && Date.parse(payload.extractedAt) < Math.max(
    task.createdAt.getTime(), task.startedAt?.getTime() ?? 0,
  )) {
    throw new AuditSubmissionError("提取时间早于当前任务或本次执行，请重新采集", "STALE_EXTRACTION");
  }
  assertAuditContentIdentity(task, payload);
}

/** Acquire a guarded write lock before any note/extraction/result mutation. */
export async function lockExternalAuditSubmission(
  tx: Prisma.TransactionClient,
  task: AuditTask,
) {
  const claimed = await tx.auditTask.updateMany({
    where: {
      id: task.id,
      status: task.status,
      updatedAt: task.updatedAt,
      batchId: null,
      claimEpoch: null,
      auditResults: { none: {} },
    },
    data: { status: "PROCESSING" },
  });
  if (claimed.count !== 1) {
    throw new AuditSubmissionError("任务已变更或已有审核结果，拒绝迟到提交；请刷新或重新审核", "STALE_AUDIT_SUBMISSION");
  }
}
