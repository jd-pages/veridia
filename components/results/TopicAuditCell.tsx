"use client";

import { Popover, Tag } from "antd";
import { parseJsonArray } from "@/lib/client";
import { normalizeTopic } from "@/lib/topic";
import { classifyTopicCandidates } from "@/lib/topic-clickability";
import type { ResultRow } from "./types";
import styles from "./results-workbench.module.css";

function expectedTopics(ruleSnapshot: string) {
  try {
    const snapshot = JSON.parse(ruleSnapshot) as {
      rules?: Array<{
        ruleType?: string;
        topic?: string;
      }>;
    };
    return [
      ...new Set(
        (snapshot.rules || [])
          .filter(
            (rule) =>
              Boolean(rule.topic) &&
              rule.ruleType !== "FORBIDDEN" &&
              rule.ruleType !== "ALIAS",
          )
          .map((rule) => normalizeTopic(rule.topic || "")),
      ),
    ];
  } catch {
    return [];
  }
}

export function getTopicAuditSummary(row: ResultRow) {
  const required = expectedTopics(row.ruleSnapshot);
  const actual = row.note.topics.map((topic) => normalizeTopic(topic.displayText));
  const matched = required.filter((topic) => actual.includes(topic));
  const missing = parseJsonArray(row.missingTopics).filter(
    (expected) => !actual.includes(normalizeTopic(expected)),
  );
  const forbidden = parseJsonArray(row.forbiddenTopics);
  const unclickable = required.filter((expected) => {
    const topics = row.note.topics.filter(
      (candidate) => normalizeTopic(candidate.displayText) === expected,
    );
    return (
      topics.length > 0 &&
      classifyTopicCandidates(topics) === "NOT_CLICKABLE"
    );
  });
  const uncertain = required.filter((expected) => {
    const topics = row.note.topics.filter(
      (candidate) => normalizeTopic(candidate.displayText) === expected,
    );
    return (
      topics.length > 0 && classifyTopicCandidates(topics) === "UNKNOWN"
    );
  });
  return {
    required,
    matched,
    missing,
    forbidden,
    unclickable,
    uncertain,
  };
}

export default function TopicAuditCell({ row }: { row: ResultRow }) {
  const summary = getTopicAuditSummary(row);
  const expectedCount = summary.required.length;
  const matchedCount = summary.matched.length;
  const compliant =
    row.topicsCompliant &&
    row.clickableCompliant &&
    !summary.missing.length &&
    !summary.forbidden.length &&
    !summary.uncertain.length;

  const detail = (
    <div className={styles.topicDetail}>
      <div className={styles.topicDetailSection}>
        <div className={styles.topicDetailTitle}>要求话题</div>
        <div>{summary.required.join("、") || "规则快照中未配置话题"}</div>
      </div>
      {summary.missing.length ? (
        <div className={styles.topicDetailSection}>
          <div className={styles.topicDetailTitle}>缺少话题</div>
          <div>{summary.missing.join("、")}</div>
        </div>
      ) : null}
      {summary.unclickable.length ? (
        <div className={styles.topicDetailSection}>
          <div className={styles.topicDetailTitle}>不可点击话题</div>
          <div>{summary.unclickable.join("、")}</div>
        </div>
      ) : null}
      {summary.uncertain.length ? (
        <div className={styles.topicDetailSection}>
          <div className={styles.topicDetailTitle}>可点击状态待确认</div>
          <div>{summary.uncertain.join("、")}</div>
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
              summary.uncertain.length
                ? styles.statusWarning
                : compliant
                  ? styles.statusSuccess
                  : styles.statusDanger
            }`}
          >
            {summary.uncertain.length
              ? "待复核"
              : compliant
                ? "合规"
                : "异常"}
          </Tag>
        </div>
        <div className={styles.cellSecondary}>
          {summary.missing.length
            ? "要求话题缺失，可点击不适用"
            : summary.uncertain.length
              ? "可点击状态需人工确认"
              : row.clickableCompliant
              ? "全部可点击"
              : `不可点击 ${Math.max(summary.unclickable.length, 1)} 个`}
        </div>
        {summary.missing.length ? (
          <div className={styles.cellSecondary}>
            缺少 {summary.missing.length} 个
          </div>
        ) : null}
      </div>
    </Popover>
  );
}
