import { interactionRewardPresentation, type InteractionRewardSnapshot } from "@/lib/interaction-reward";

export default function InteractionReward({ snapshot, detail = false }: { snapshot: InteractionRewardSnapshot; detail?: boolean }) {
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
