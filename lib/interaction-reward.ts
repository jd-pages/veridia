export type RewardMode = "LEGACY" | "CONTENT_BASE_PLUS_INTERACTION_TIERS";

export interface InteractionRewardTier {
  threshold: number;
  amount: number;
}

export interface RewardResultSnapshotInput extends InteractionRewardSnapshot {
  ruleSnapshot: string | null | undefined;
  finalContentStatus: string;
  pageStatus: string;
  autoStatus?: string;
  failureCode?: string | null;
}

export interface ResultSnapshotReward {
  mode: RewardMode;
  baseRewardAmount: number | null;
  total: number | null;
  qualifiedTier: InteractionRewardTier | null;
  extraRewardAmount: number | null;
  nextTier: InteractionRewardTier | null;
  maxTierReached: boolean;
}

export interface InteractionRewardSnapshot {
  likeCount?: number | null;
  commentCount?: number | null;
  favoriteCount?: number | null;
  interactionTotal?: number | null;
  interactionRewardThreshold?: number | null;
  interactionRewardStatus?: string;
}

export function calculateInteractionTotal(note: {
  likeCount?: number | null;
  commentCount?: number | null;
  favoriteCount?: number | null;
  interactionExtractionStatus?: string;
}) {
  const count = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;
  const likeCount = count(note.likeCount);
  const commentCount = count(note.commentCount);
  const favoriteCount = count(note.favoriteCount);
  const readable = note.interactionExtractionStatus === "SUCCESS" &&
    [likeCount, commentCount, favoriteCount].every((value) => value !== null);
  return {
    likeCount,
    commentCount,
    favoriteCount,
    readable,
    interactionTotal: readable
      ? likeCount! + commentCount! + favoriteCount!
      : null,
  };
}

export function evaluateInteractionReward(
  note: { likeCount?: number | null; commentCount?: number | null; favoriteCount?: number | null; interactionExtractionStatus?: string },
  config: {
    rewardMode?: RewardMode;
    interactionRewardEnabled?: boolean;
    interactionRewardThreshold?: number;
    interactionRewardTiers?: InteractionRewardTier[];
  },
) {
  const { likeCount, commentCount, favoriteCount, interactionTotal } =
    calculateInteractionTotal(note);
  const tierMode = config.rewardMode === "CONTENT_BASE_PLUS_INTERACTION_TIERS";
  const threshold = tierMode ? config.interactionRewardTiers?.[0]?.threshold : config.interactionRewardThreshold;
  const enabled = tierMode || config.interactionRewardEnabled === true;
  const validThreshold = typeof threshold === "number" && Number.isSafeInteger(threshold) && threshold > 0;
  return {
    likeCount, commentCount, favoriteCount, interactionTotal,
    interactionRewardThreshold: enabled && validThreshold ? threshold : null,
    interactionRewardStatus: !enabled ? "NOT_ENABLED" : !validThreshold || interactionTotal === null
      ? "PENDING" : interactionTotal >= threshold ? "QUALIFIED" : "NOT_QUALIFIED",
  };
}

export function rewardModeFromRuleSnapshot(ruleSnapshot: string | null | undefined): RewardMode {
  try {
    const parsed = JSON.parse(ruleSnapshot || "{}") as { rewardMode?: unknown };
    return parsed?.rewardMode === "CONTENT_BASE_PLUS_INTERACTION_TIERS"
      ? "CONTENT_BASE_PLUS_INTERACTION_TIERS" : "LEGACY";
  } catch {
    return "LEGACY";
  }
}

/** Result-bound reward projection, shared by list, detail and business export. */
export function rewardFromResultSnapshot(input: RewardResultSnapshotInput): ResultSnapshotReward {
  const mode = rewardModeFromRuleSnapshot(input.ruleSnapshot);
  const blank: ResultSnapshotReward = {
    mode, baseRewardAmount: null, total: null, qualifiedTier: null,
    extraRewardAmount: null, nextTier: null, maxTierReached: false,
  };
  const technicalStatuses = new Set([
    "READ_FAILED", "NOTE_NOT_FOUND", "PROCESSING", "LOGIN_EXPIRED",
    "SECURITY_VERIFICATION", "PAGE_READ_FAILED", "NETWORK_ERROR", "STRUCTURE_MISMATCH",
  ]);
  if (input.pageStatus !== "NORMAL" || technicalStatuses.has(input.autoStatus || "") ||
    technicalStatuses.has(input.failureCode || "") ||
    !["PASSED", "FAILED", "NEEDS_REVIEW", "PENDING_RETENTION"].includes(input.autoStatus || input.finalContentStatus)) {
    return blank;
  }
  // This normalization is a business projection only; raw persisted counts stay null.
  const normalized = calculateInteractionTotal({
    likeCount: input.likeCount ?? 0,
    commentCount: input.commentCount ?? 0,
    favoriteCount: input.favoriteCount ?? 0,
    interactionExtractionStatus: "SUCCESS",
  });
  const countFieldsAbsent = [input.likeCount, input.commentCount, input.favoriteCount]
    .every((value) => value === undefined);
  const storedTotal = input.interactionTotal;
  const total = countFieldsAbsent && typeof storedTotal === "number" &&
    Number.isSafeInteger(storedTotal) && storedTotal >= 0
    ? storedTotal : normalized.interactionTotal;
  if (mode === "LEGACY") return { ...blank, total };
  let config: { baseRewardAmount?: unknown; interactionRewardTiers?: unknown };
  try {
    config = JSON.parse(input.ruleSnapshot || "{}");
  } catch {
    return { ...blank, total };
  }
  const integer = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const rawTiers = config?.interactionRewardTiers;
  if (!integer(config?.baseRewardAmount) || !Array.isArray(rawTiers) || !rawTiers.length ||
    !rawTiers.every((tier: unknown) => tier && typeof tier === "object" &&
      integer((tier as InteractionRewardTier).threshold) && (tier as InteractionRewardTier).threshold > 0 &&
      integer((tier as InteractionRewardTier).amount))) return { ...blank, total };
  const tiers = (rawTiers as InteractionRewardTier[])
    .map(({ threshold, amount }) => ({ threshold, amount }))
    .sort((left, right) => left.threshold - right.threshold);
  if (new Set(tiers.map((tier) => tier.threshold)).size !== tiers.length) return { ...blank, total };
  if (input.finalContentStatus === "FAILED") {
    return { ...blank, total, baseRewardAmount: 0, extraRewardAmount: 0 };
  }
  if (input.finalContentStatus !== "PASSED" || total === null) return { ...blank, total };
  const qualifiedTier = tiers.filter((tier) => total >= tier.threshold).at(-1) || null;
  const nextTier = tiers.find((tier) => tier.threshold > total) || null;
  return {
    mode, total, baseRewardAmount: config.baseRewardAmount,
    qualifiedTier, extraRewardAmount: qualifiedTier?.amount ?? 0,
    nextTier, maxTierReached: nextTier === null,
  };
}

export function interactionRewardPresentation(snapshot: InteractionRewardSnapshot) {
  if (!snapshot.interactionRewardStatus || snapshot.interactionRewardStatus === "NOT_ENABLED") return null;
  const status = snapshot.interactionRewardStatus === "QUALIFIED" ? "达标"
    : snapshot.interactionRewardStatus === "NOT_QUALIFIED" ? "未达标" : "待确认";
  const total = snapshot.interactionTotal;
  const threshold = snapshot.interactionRewardThreshold;
  return {
    status,
    compact: status === "待确认" ? status : `${status} ${total} / ${threshold}`,
    counts: `赞 ${snapshot.likeCount ?? "待确认"} · 评 ${snapshot.commentCount ?? "待确认"} · 藏 ${snapshot.favoriteCount ?? "待确认"}`,
    description: status === "待确认" ? "互动数据未完整获取，暂无法判断额外奖励"
      : status === "达标" ? `点赞+评论+收藏≥${threshold}，可获得额外奖励`
      : `当前互动 ${total}，未达到额外奖励门槛 ${threshold}`,
  };
}

/**
 * 惠氏/雀巢业务表的“互动量≥10”只读取审核时保存的正式互动合计。
 * 缺少完整互动证据时不能把未知误写成未达标。
 */
export function interactionAtLeastTenExportValue(
  snapshot: InteractionRewardSnapshot,
) {
  const total = snapshot.interactionTotal;
  if (
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 0
  ) {
    return "";
  }
  return total >= 10 ? "Y" : "N";
}
