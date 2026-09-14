"use client";

import { memo } from "react";
import { Popover, Tag } from "antd";
import { productStageTopicLabel } from "@/lib/product-stage";
import type { ResultRow } from "./types";
import styles from "./results-workbench.module.css";

function TopicAuditCell({ row }: { row: ResultRow }) {
  const summary = row.presentation.topic;
  if (summary.status === "UNAVAILABLE") {
    return (
      <div className={styles.stack}>
        <span className={styles.cellPrimary}>
          {summary.source === "LEGACY_UNAVAILABLE" ? "历史明细不可用" : "未审核"}
        </span>
        {summary.message ? <span className={styles.cellSecondary}>{summary.message}</span> : null}
      </div>
    );
  }

  const expectedCount = summary.expectedCount;
  const matchedCount = summary.matchedCount;
  const needsReview = summary.status === "NEEDS_REVIEW";
  const compliant = summary.status === "COMPLIANT";

  const detail = (
    <div className={styles.topicDetail}>
      <div className={styles.topicDetailSection}>
        <div className={styles.topicDetailTitle}>必带话题</div>
        <div>
          {summary.required.join("、") || "无额外通用或产品必填话题"}
        </div>
      </div>
      {summary.anyCandidates.length ? (
        <div className={styles.topicDetailSection}>
          <div className={styles.topicDetailTitle}>
            热门话题（{summary.anyCandidates.length} 选 {summary.anyMinimum}）
          </div>
          <div>
            已命中：{summary.matchedAnyCandidates.join("、") || "无"}
          </div>
          <div>
            未命中候选：{summary.unmatchedAnyCandidates.join("、") || "无"}
          </div>
        </div>
      ) : null}
      {summary.stageCandidates.length ? (
        <div className={styles.topicDetailSection}>
          <div className={styles.topicDetailTitle}>
            {productStageTopicLabel(row.task.productStage)} 阶段话题
          </div>
          <div>{summary.stageCandidates.join(" / ")}</div>
        </div>
      ) : null}
      {summary.stageGroupMissing ? (
        <div className={styles.topicDetailSection}>
          <div className={styles.topicDetailTitle}>阶段话题未命中</div>
          <div>{summary.stageCandidates.join(" / ")}</div>
        </div>
      ) : null}
      {summary.missing.length ? (
        <div className={styles.topicDetailSection}>
          <div className={styles.topicDetailTitle}>缺少话题</div>
          <div>{summary.missing.join("、")}</div>
        </div>
      ) : null}
      {summary.unclickable.length || summary.stageGroupUnclickable ? (
        <div className={styles.topicDetailSection}>
          <div className={styles.topicDetailTitle}>不可点击话题</div>
          <div>
            {[
              ...summary.unclickable,
              ...(summary.stageGroupUnclickable
                ? summary.matchedStageCandidates
                : []),
            ].join("、")}
          </div>
        </div>
      ) : null}
      {needsReview ? (
        <div className={styles.topicDetailSection}>
          <div className={styles.topicDetailTitle}>可点击状态待确认</div>
          <div>
            {[
              ...summary.uncertain,
              ...(summary.stageGroupUncertain
                ? summary.matchedStageCandidates
                : []),
            ].join("、")}
          </div>
        </div>
      ) : null}
      {summary.forbidden.length ? (
        <div className={styles.topicDetailSection}>
          <div className={styles.topicDetailTitle}>命中禁止话题</div>
          <div>{summary.forbidden.join("、")}</div>
        </div>
      ) : null}
    </div>
  );

  return (
    <Popover content={detail} title="话题审核详情" trigger={["hover", "click"]}>
      <div className={styles.stack}>
        <div className={styles.topicScore}>
          <strong>
            {matchedCount} / {expectedCount}
          </strong>
          <Tag
            bordered={false}
            className={`${styles.compactTag} ${
              needsReview
                ? styles.statusWarning
                : compliant
                  ? styles.statusSuccess
                  : styles.statusDanger
            }`}
          >
            {needsReview ? "待复核" : compliant ? "合规" : "异常"}
          </Tag>
        </div>
        <div className={styles.cellSecondary}>
          {summary.stageGroupMissing
            ? "阶段话题候选均未命中"
            : summary.anyMissingCount
              ? `热门话题还需任意 ${summary.anyMissingCount} 个`
            : summary.missing.length
              ? "要求话题缺失，可点击不适用"
              : needsReview
                ? "可点击状态需人工确认"
                 : compliant
                   ? "全部可点击"
                   : summary.unclickable.length || summary.stageGroupUnclickable
                     ? `不可点击 ${Math.max(
                       summary.unclickable.length +
                         (summary.stageGroupUnclickable ? 1 : 0),
                       1,
                     )} 个`
                     : "话题规则不合规"}
        </div>
        {summary.missing.length ||
        summary.anyMissingCount ||
        summary.stageGroupMissing ? (
          <div className={styles.cellSecondary}>
            {summary.missing.length
              ? `缺少必带话题 ${summary.missing.length} 个`
              : summary.anyMissingCount
                ? `热门话题还需任意 ${summary.anyMissingCount} 个`
                : "阶段话题需任意命中 1 个"}
          </div>
        ) : null}
      </div>
    </Popover>
  );
}

export default memo(TopicAuditCell);
