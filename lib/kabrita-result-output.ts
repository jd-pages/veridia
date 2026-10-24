import { detailedSelfReview, type SelfReviewSource } from "@/lib/result-self-review";
import { rewardFromResultSnapshot, rewardModeFromRuleSnapshot, type InteractionRewardSnapshot } from "@/lib/interaction-reward";
import { resultBoundNextReviewDate, resultBoundManualReviewDate } from "@/lib/result-next-review-date";

export type KabritaResultOutputInput = SelfReviewSource & InteractionRewardSnapshot & {
  evidenceStatus?: "RESULT_BOUND" | "LEGACY_UNAVAILABLE";
  retentionStatus?: string;
  note: SelfReviewSource["note"] & {
    publishedAt?: unknown; publishedAtRaw?: unknown; publishedAtSource?: unknown;
    businessDataReceipt?: unknown;
    contentChannel?: unknown; platformNoteId?: unknown; url?: string | null;
    finalUrl?: string | null; lastCapturedAt?: unknown;
  };
  task: SelfReviewSource["task"] & { url?: string | null; channel?: string | null; platform?: string | null };
};

function contentStatus(row: SelfReviewSource) {
  return row.manualReviews[0]?.result || row.presentation?.conclusion.status || row.autoStatus;
}

/** Explicit persisted page outcomes only. Technical failures never prove deletion. */
function terminalCompliance(row: SelfReviewSource): string | null {
  if (row.pageStatus === "NOTE_NOT_FOUND" || row.autoStatus === "NOTE_NOT_FOUND") return "N-笔记不存在";
  if (row.pageStatus === "DELETED") return "N-笔记已删除";
  if (row.pageStatus === "NO_PERMISSION") return "N-页面不可访问：当前账号无权访问笔记";
  if (["PAGE_NOT_FOUND", "PAGE_UNAVAILABLE", "NOT_ACCESSIBLE"].includes(row.pageStatus)) return "N-链接失效或页面不可访问";
  if (["PENDING", "QUEUED", "PROCESSING"].includes(row.autoStatus)) return "未审核";
  if (row.pageStatus !== "NORMAL" || ["READ_FAILED", "LOGIN_EXPIRED", "SECURITY_VERIFICATION", "PAGE_READ_FAILED", "NETWORK_ERROR", "STRUCTURE_MISMATCH"].includes(row.autoStatus) ||
    ["READ_FAILED", "LOGIN_EXPIRED", "SECURITY_VERIFICATION", "PAGE_READ_FAILED", "NETWORK_ERROR", "STRUCTURE_MISMATCH"].includes(row.task.failureCode || "")) {
    return `待复核：${row.task.failureMessage?.trim() || "读取失败或审核证据不足"}`;
  }
  return null;
}

export function kabritaComplianceResult(row: KabritaResultOutputInput): string {
  const terminal = terminalCompliance(row);
  if (terminal) return terminal;
  if (row.presentation?.consistency.status === "RESULT_CONSISTENCY_VIOLATION") return "待复核：结果一致性异常";
  if (rewardModeFromRuleSnapshot(row.ruleSnapshot) === "CONTENT_BASE_PLUS_INTERACTION_TIERS") {
    const status = contentStatus(row);
    if (status === "PASSED") return "Y";
    if (status === "FAILED") return detailedSelfReview(row);
    return `待复核：${row.presentation?.reviewReasons.join("；") || "内容审核证据不足"}`;
  }
  // Keep the legacy basic-reward contract; tier campaigns do not use this gate.
  let base = detailedSelfReview(row);
  if (!row.manualReviews.length) {
    let reasons: string[] = [];
    try { const parsed = JSON.parse(row.failureReasons); reasons = Array.isArray(parsed) ? parsed.map(String) : [String(parsed || "")]; }
    catch { reasons = row.failureReasons ? [row.failureReasons] : []; }
    const interactionReason = /基础奖励(?:未达成|互动数据无法确认)|互动合计/iu;
    const others = reasons.filter((reason) => !interactionReason.test(reason));
    if (reasons.some((reason) => interactionReason.test(reason))) {
      const status = others.length ? row.autoStatus : "PASSED";
      const presentation = row.presentation?.consistency.status === "CONSISTENT" ? {
        ...row.presentation,
        automaticConclusion: { ...row.presentation.automaticConclusion, status },
        conclusion: { ...row.presentation.conclusion, status },
        failureReasons: row.presentation.failureReasons.filter((reason) => !interactionReason.test(reason)),
      } : row.presentation;
      base = detailedSelfReview({ ...row, autoStatus: status, failureReasons: JSON.stringify(others), presentation });
    }
  }
  const total = rewardFromResultSnapshot({ ...row, ruleSnapshot: row.ruleSnapshot, finalContentStatus: contentStatus(row), failureCode: row.task.failureCode }).total;
  if (total === null) return base === "Y" ? "待复核：互动数据未完整获取" : base;
  if (base === "Y") return total >= 10 ? "Y" : "N-互动量＜10";
  if (total >= 10 || base.includes("互动量＜10")) return base;
  return `${base}；N-互动量＜10`;
}

/** Read-only projection of this result's frozen rules and extraction. No current Campaign/Note reads. */
export function kabritaResultOutput(row: KabritaResultOutputInput) {
  const receipt = row.note.businessDataReceipt && typeof row.note.businessDataReceipt === "object"
    ? row.note.businessDataReceipt as Record<string, unknown> : null;
  const blockerLabels: Record<string, string> = {
    CURRENT_NOTE_ID_UNCONFIRMED: "当前笔记身份未确认", INTERACTION_COUNT_CONFLICT: "当前笔记互动数据来源冲突",
    PLATFORM_INTERACTION_NOT_RETURNED: "平台未返回完整点赞、评论和收藏数据",
    PUBLISHED_TIME_CONFLICT: "原始发布时间来源冲突", ORIGINAL_PUBLISHED_TIME_NOT_RETURNED: "平台未返回可确认的原始发布时间",
  };
  const acquisitionReasons = Array.isArray(receipt?.blockers)
    ? receipt.blockers.filter((code): code is string => typeof code === "string" && Object.hasOwn(blockerLabels, code)).map((code) => blockerLabels[code]) : [];
  const acquisitionRecovery = acquisitionReasons.length
    ? "系统按正常会话安排有界自动补采；仍缺失时请在审核任务查看补采结果。登录失效需正常恢复登录，访问受限需确认原笔记权限。原历史快照不变。" : null;
  const complianceResult = kabritaComplianceResult(row);
  const reward = rewardFromResultSnapshot({ ...row, ruleSnapshot: row.ruleSnapshot, finalContentStatus: contentStatus(row), failureCode: row.task.failureCode });
  // An inaccessible page does not prove that the note no longer exists.
  const noNote = row.pageStatus === "NOTE_NOT_FOUND" || row.autoStatus === "NOTE_NOT_FOUND" || row.pageStatus === "DELETED";
  const nextDate = noNote || complianceResult === "未审核" ? null : resultBoundNextReviewDate({
    evidenceStatus: row.evidenceStatus, publishedAt: row.note.publishedAt,
    publishedAtRaw: row.note.publishedAtRaw, publishedAtSource: row.note.publishedAtSource,
  });
  const manualDate = noNote || complianceResult === "未审核" ? null : resultBoundManualReviewDate({
    evidenceStatus: row.evidenceStatus, publishedAt: row.note.publishedAt,
    publishedAtRaw: row.note.publishedAtRaw, publishedAtSource: row.note.publishedAtSource,
    contentChannel: row.note.contentChannel ?? row.task.channel ?? row.task.platform,
    platformNoteId: row.note.platformNoteId, noteUrl: row.note.url,
    originalUrl: row.task.url, finalUrl: row.note.finalUrl, capturedAt: row.note.lastCapturedAt,
  });
  const nextReviewAt = manualDate?.date?.toISOString().slice(0, 10) ?? (noNote ? "不适用" : complianceResult === "未审核" ? "未审核" : "发布时间待确认");
  const nextReviewEstimated = manualDate?.estimated ?? false;
  const nextReviewReason = manualDate?.date ? manualDate.reason : noNote ? "笔记已确认不存在或不可访问" : complianceResult === "未审核" ? "尚无审核结果" : acquisitionReasons.length ? acquisitionReasons.join("；") : "当次采集快照未包含可确认的绝对发布时间与可信来源，不使用当前笔记或导入日期替代";
  const payoutAmount = complianceResult === "Y" && reward.mode === "CONTENT_BASE_PLUS_INTERACTION_TIERS" && reward.baseRewardAmount !== null && reward.extraRewardAmount !== null
    ? reward.baseRewardAmount + reward.extraRewardAmount : null;
  const payoutState = complianceResult.startsWith("N-") ? "不适用：内容审核不合格" : complianceResult === "未审核" ? "未审核"
    : complianceResult !== "Y" ? "待确认：内容审核待复核"
    : reward.mode !== "CONTENT_BASE_PLUS_INTERACTION_TIERS" ? "待确认：缺少当次有效奖励规则快照"
    : reward.total === null ? "待确认：互动数据未完整获取"
    : reward.baseRewardAmount === null ? "待确认：缺少当次有效奖励规则快照"
    : row.retentionStatus === "SATISFIED" && nextDate ? "留存已确认：应付测算，非已付款" : "待复核：30天留存尚未确认；应付测算，非已付款";
  return { complianceResult, interactionTotal: reward.total, payoutAmount, payoutState, nextReviewAt, nextReviewEstimated, nextReviewReason,
    acquisitionReasons, acquisitionRecovery };
}

export type KabritaResultOutput = ReturnType<typeof kabritaResultOutput>;
