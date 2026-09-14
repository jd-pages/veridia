"use client";

import { memo } from "react";
import { Tag, Tooltip } from "antd";
import {
  duplicateReauditMetadataFromNotes,
} from "@/lib/import-task-metadata";
import AuditStatusTag from "./AuditStatusTag";
import InteractionReward from "./InteractionReward";
import type { ResultRow } from "./types";
import styles from "./results-workbench.module.css";

function AuditConclusionCell(props: {
  row: ResultRow;
  detailView?: boolean;
}) {
  const { row } = props;
  const duplicateReaudit = duplicateReauditMetadataFromNotes(row.task.notes);
  const reasons = row.presentation.failureReasons;
  const pendingReasons = row.presentation.pendingReasons;
  const manual = row.manualReviews[0];
  const dotClass = (tone: string) => tone === "success"
    ? styles.dotSuccess
    : tone === "danger"
      ? styles.dotDanger
      : tone === "warning"
        ? styles.dotWarning
        : styles.dotInfo;
  const autoMeta = {
    className: dotClass(row.presentation.automaticConclusion.tone),
    label: row.presentation.automaticConclusion.label,
  };
  const mainValue = row.presentation.conclusion.status;
  const processingFailed = [
    "FAILED",
    "READ_FAILED",
    "LOGIN_EXPIRED",
  ].includes(row.task.status);
  const mainMeta = {
    className: dotClass(row.presentation.conclusion.tone),
    label: row.presentation.conclusion.label,
  };

  return (
    <div className={styles.stack}>
      <InteractionReward snapshot={row} />
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
      ) : pendingReasons.length ? (
        <div className={styles.cellSecondary}>
          {pendingReasons.join("；")}
          {row.presentation.retentionDisplay.dueAt
            ? ` · ${new Date(row.presentation.retentionDisplay.dueAt).toLocaleString("zh-CN", { hour12: false })} 后验证`
            : ""}
        </div>
      ) : (
        <div className={styles.cellSecondary}>
          {mainValue === "PASSED" ? "无异常" : "暂无补充原因"}
        </div>
      )}
    </div>
  );
}

export default memo(AuditConclusionCell);
