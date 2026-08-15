"use client";

import { Tag, Tooltip } from "antd";
import { auditResultLabels } from "@/lib/zh-CN";
import {
  auditDetailStatusLabel,
} from "@/lib/audit-detail-visibility";
import { auditConclusionFailureReasons } from "@/lib/result-detail-presentation";
import { auditResultListDisplay } from "@/lib/result-display";
import { duplicateReauditMetadataFromNotes } from "@/lib/import-task-metadata";
import AuditStatusTag from "./AuditStatusTag";
import type { ResultRow } from "./types";
import styles from "./results-workbench.module.css";

const resultMeta: Record<
  string,
  { className: string; label: string }
> = {
  PASSED: { className: styles.dotSuccess, label: "审核通过" },
  FAILED: { className: styles.dotDanger, label: "审核不通过" },
  NOTE_NOT_FOUND: { className: styles.dotInfo, label: "笔记不存在" },
  NEEDS_REVIEW: { className: styles.dotWarning, label: "待人工复核" },
  READ_FAILED: { className: styles.dotWarning, label: "读取失败" },
  PROCESSING: { className: styles.dotInfo, label: "处理中" },
};

export default function AuditConclusionCell({
  row,
  detailView = false,
}: {
  row: ResultRow;
  detailView?: boolean;
}) {
  const duplicateReaudit = duplicateReauditMetadataFromNotes(row.task.notes);
  const unavailableDisplay = auditResultListDisplay(row);
  if (unavailableDisplay) {
    const reasons = auditConclusionFailureReasons(row);
    return (
      <div className={styles.stack}>
        {duplicateReaudit ? (
          <div>
            <Tag color="orange">
              重复重审 · 历史 {duplicateReaudit.historicalCount} 次
            </Tag>
          </div>
        ) : null}
        <div className={styles.conclusionLine}>
          <span
            className={`${styles.conclusionDot} ${styles.dotInfo}`}
            aria-hidden="true"
          />
          <strong className={styles.cellPrimary}>
            {unavailableDisplay.auditConclusion}
          </strong>
        </div>
        {reasons.length ? (
          <Tooltip title={reasons.join("；")}>
            <div className={styles.reasonText}>{reasons.join("；")}</div>
          </Tooltip>
        ) : null}
      </div>
    );
  }

  const reasons = auditConclusionFailureReasons(row);
  const manual = row.manualReviews[0];
  const automaticResult = duplicateReaudit?.automaticResult || row.autoStatus;
  const autoMeta = resultMeta[automaticResult] || {
    className: styles.dotInfo,
    label: detailView
      ? auditDetailStatusLabel(automaticResult, "audit")
      : auditResultLabels[automaticResult] || "暂无结论",
  };
  const mainValue = manual?.result || row.autoStatus;
  const processingFailed = [
    "FAILED",
    "READ_FAILED",
    "LOGIN_EXPIRED",
  ].includes(row.task.status);
  const mainMeta = manual
    ? {
        className:
          manual.result === "PASSED" ? styles.dotSuccess : styles.dotDanger,
        label: manual.result === "PASSED" ? "人工通过" : "人工不通过",
      }
    : autoMeta;

  return (
    <div className={styles.stack}>
      {duplicateReaudit ? (
        <div>
          <Tag color="orange">
            重复重审 · 历史 {duplicateReaudit.historicalCount} 次
          </Tag>
        </div>
      ) : null}
      {processingFailed ? (
        <div>
          <AuditStatusTag value={row.task.status} domain="process" />
        </div>
      ) : null}
      <div className={styles.conclusionLine}>
        <span
          className={`${styles.conclusionDot} ${mainMeta.className}`}
          aria-hidden="true"
        />
        <strong className={styles.cellPrimary}>{mainMeta.label}</strong>
      </div>
      {manual ? (
        <div className={styles.cellSecondary}>
          自动结果：{autoMeta.label}
        </div>
      ) : duplicateReaudit ? (
        <div className={styles.cellSecondary}>
          自动结果：{autoMeta.label} · 待人工确认
        </div>
      ) : reasons.length ? (
        <Tooltip title={reasons.join("；")}>
          <div className={styles.reasonText}>{reasons.join("；")}</div>
        </Tooltip>
      ) : (
        <div className={styles.cellSecondary}>
          {mainValue === "PASSED" ? "无异常" : "暂无补充原因"}
        </div>
      )}
    </div>
  );
}
