export interface InteractionRewardSnapshot {
  likeCount?: number | null;
  commentCount?: number | null;
  favoriteCount?: number | null;
  interactionTotal?: number | null;
  interactionRewardThreshold?: number | null;
  interactionRewardStatus?: string;
}

export function evaluateInteractionReward(
  note: { likeCount?: number | null; commentCount?: number | null; favoriteCount?: number | null; interactionExtractionStatus?: string },
  config: { interactionRewardEnabled?: boolean; interactionRewardThreshold?: number },
) {
  const count = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const likeCount = count(note.likeCount);
  const commentCount = count(note.commentCount);
  const favoriteCount = count(note.favoriteCount);
  const readable = note.interactionExtractionStatus === "SUCCESS" &&
    [likeCount, commentCount, favoriteCount].every((value) => value !== null);
  const interactionTotal = readable ? likeCount! + commentCount! + favoriteCount! : null;
  const threshold = config.interactionRewardThreshold;
  const enabled = config.interactionRewardEnabled === true;
  const validThreshold = typeof threshold === "number" && Number.isSafeInteger(threshold) && threshold > 0;
  return {
    likeCount, commentCount, favoriteCount, interactionTotal,
    interactionRewardThreshold: enabled && validThreshold ? threshold : null,
    interactionRewardStatus: !enabled ? "NOT_ENABLED" : !validThreshold || interactionTotal === null
      ? "PENDING" : interactionTotal >= threshold ? "QUALIFIED" : "NOT_QUALIFIED",
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
