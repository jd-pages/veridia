"use client";

import { Popover, Tag } from "antd";
import { parseJsonArray } from "@/lib/client";
import { productStageTopicLabel } from "@/lib/product-stage";
import { auditResultListDisplay } from "@/lib/result-display";
import { normalizeTopic } from "@/lib/topic";
import { topicAuditRuleSummary } from "@/lib/topic-audit-summary";
import { classifyTopicCandidates } from "@/lib/topic-clickability";
import type { ResultRow } from "./types";
import styles from "./results-workbench.module.css";

export function getTopicAuditSummary(row: ResultRow) {
  const actual = row.note.topics.map((topic) =>
    normalizeTopic(topic.displayText),
  );
  const ruleSummary = topicAuditRuleSummary(row.ruleSnapshot, actual);
  const required = ruleSummary.requiredTopics;
  const matched = ruleSummary.matchedRequiredTopics;
  const { stageCandidates, matchedStageCandidates } = ruleSummary;
  const missing = parseJsonArray(row.missingTopics).filter(
    (expected) => !actual.includes(normalizeTopic(expected)),
  );
  const forbidden = parseJsonArray(row.forbiddenTopics);
  const clickabilityFor = (expected: string) => {
    const topics = row.note.topics.filter(
      (candidate) => normalizeTopic(candidate.displayText) === expected,
    );
    return topics.length
      ? classifyTopicCandidates(topics, { pageUrl: row.note.url })
      : null;
  };
  const unclickable = required.filter(
    (expected) => clickabilityFor(expected) === "NOT_CLICKABLE",
  );
  const uncertain = required.filter(
    (expected) => clickabilityFor(expected) === "UNKNOWN",
  );
  const stageClickabilities = matchedStageCandidates.map(clickabilityFor);
  const stageGroupMissing =
    stageCandidates.length > 0 && matchedStageCandidates.length === 0;
  const stageGroupUnclickable =
    matchedStageCandidates.length > 0 &&
    stageClickabilities.every((value) => value === "NOT_CLICKABLE");
  const stageGroupUncertain =
    matchedStageCandidates.length > 0 &&
    !stageClickabilities.includes("CLICKABLE") &&
    stageClickabilities.some((value) => value === "UNKNOWN");
  return {
    required,
    matched,
    anyCandidates: ruleSummary.anyCandidates,
    anyMinimum: ruleSummary.anyMinimum,
    matchedAnyCandidates: ruleSummary.matchedAnyCandidates,
    unmatchedAnyCandidates: ruleSummary.unmatchedAnyCandidates,
    anyMissingCount: ruleSummary.anyMissingCount,
    expectedCount: ruleSummary.expectedCount,
    matchedCount: ruleSummary.matchedCount,
    stageCandidates,
    matchedStageCandidates,
    stageGroupMissing,
    stageGroupUnclickable,
    stageGroupUncertain,
    missing,
    forbidden,
    unclickable,
    uncertain,
  };
}

export default function TopicAuditCell({ row }: { row: ResultRow }) {
  const unavailableDisplay = auditResultListDisplay(row);
  if (unavailableDisplay) {
    return (
      <span className={styles.cellPrimary}>
        {unavailableDisplay.topicAudit}
      </span>
    );
  }

  const summary = getTopicAuditSummary(row);
  const expectedCount = summary.expectedCount;
  const matchedCount = summary.matchedCount;
  const needsReview =
    summary.uncertain.length > 0 || summary.stageGroupUncertain;
  const compliant =
    row.topicsCompliant &&
    row.clickableCompliant &&
    !summary.missing.length &&
    !summary.anyMissingCount &&
    !summary.forbidden.length &&
    !summary.stageGroupMissing &&
    !summary.stageGroupUnclickable &&
    !needsReview;

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
                : row.clickableCompliant
                  ? "全部可点击"
                  : `不可点击 ${Math.max(
                      summary.unclickable.length +
                        (summary.stageGroupUnclickable ? 1 : 0),
                      1,
                    )} 个`}
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
