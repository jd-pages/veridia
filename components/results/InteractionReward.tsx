import { interactionRewardPresentation, type InteractionRewardSnapshot, type ResultSnapshotReward } from "@/lib/interaction-reward";

export default function InteractionReward({ snapshot, reward, detail = false }: {
  snapshot: InteractionRewardSnapshot;
  reward?: ResultSnapshotReward;
  detail?: boolean;
}) {
  if (reward?.mode === "CONTENT_BASE_PLUS_INTERACTION_TIERS") {
    return <div aria-label="互动奖励" style={{ fontSize: 12, lineHeight: 1.6 }}>
      <strong>互动奖励</strong>
      <div>互动合计：{reward.total ?? "未判定"}</div>
      <div>基础奖励：{reward.baseRewardAmount === null ? "未判定" : `${reward.baseRewardAmount} 元`}</div>
      <div>额外奖励：{reward.extraRewardAmount === null ? "未判定" : `${reward.extraRewardAmount} 元`}</div>
      {detail ? <>
        <div>原始点赞：{snapshot.likeCount ?? "未取得"} · 评论：{snapshot.commentCount ?? "未取得"} · 收藏：{snapshot.favoriteCount ?? "未取得"}</div>
        {reward.qualifiedTier && <div>达标档位：互动量≥{reward.qualifiedTier.threshold}，额外 {reward.qualifiedTier.amount} 元</div>}
        {reward.nextTier && <div>下一档：互动量≥{reward.nextTier.threshold}，额外 {reward.nextTier.amount} 元</div>}
        {reward.maxTierReached && <div>已达到最高互动奖励档位</div>}
        <div>内容审核与互动奖励独立；额外奖励取最高达标档位，不累加。</div>
      </> : null}
    </div>;
  }
  const view = interactionRewardPresentation(snapshot);
  if (!view) return null;
  return <div aria-label="互动奖励" style={{ fontSize: 12, lineHeight: 1.6 }}>
    <strong>互动奖励</strong>
    <div>{view.compact}</div>
    {detail ? <>
      <div>点赞：{snapshot.likeCount ?? "待确认"} · 评论：{snapshot.commentCount ?? "待确认"} · 收藏：{snapshot.favoriteCount ?? "待确认"}</div>
      <div>互动合计：{snapshot.interactionTotal ?? "待确认"} · 奖励门槛：{snapshot.interactionRewardThreshold ?? "待确认"}</div>
      <div>奖励结果：{view.status}</div>
      <div>{view.description}</div>
    </> : <div title={view.description}>{view.counts}</div>}
  </div>;
}
