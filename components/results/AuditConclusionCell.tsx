"use client";

import { Tooltip } from "antd";
import { parseJsonArray } from "@/lib/client";
import {
  auditResultLabels,
  businessFailureReasonLabel,
} from "@/lib/zh-CN";
import type { ResultRow } from "./types";
import styles from "./results-workbench.module.css";

const resultMeta: Record<
  string,
  { className: string; label: string }
> = {
  PASSED: { className: styles.dotSuccess, label: "审核通过" },
  FAILED: { className: styles.dotDanger, label: "审核不通过" },
  NEEDS_REVIEW: { className: styles.dotWarning, label: "待人工复核" },
  READ_FAILED: { className: styles.dotWarning, label: "读取失败" },
  PROCESSING: { className: styles.dotInfo, label: "处理中" },
};

export default function AuditConclusionCell({ row }: { row: ResultRow }) {
  const reasons = parseJsonArray(row.failureReasons)
    .filter(
      (reason) =>
        !/首图|视觉|产品实拍|合照|罐体|平台导向|图片内容/u.test(reason),
    )
    .map(businessFailureReasonLabel);
  const manual = row.manualReviews[0];
  const autoMeta = resultMeta[row.autoStatus] || {
    className: styles.dotInfo,
    label: auditResultLabels[row.autoStatus] || "暂无结论",
  };
  const mainValue = manual?.result || row.autoStatus;
  const mainMeta = manual
    ? {
        className:
          manual.result === "PASSED" ? styles.dotSuccess : styles.dotDanger,
        label: manual.result === "PASSED" ? "人工通过" : "人工不通过",
      }
    : autoMeta;

  return (
    <div className={styles.stack}>
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
      ) : reasons.length ? (
        <>
          <Tooltip title={reasons[0]}>
            <div className={styles.reasonText}>{reasons[0]}</div>
          </Tooltip>
          <div className={styles.cellSecondary}>
            {reasons.length} 项异常
            {reasons.length > 1 ? `，另有 ${reasons.length - 1} 项` : ""}
          </div>
        </>
      ) : (
        <div className={styles.cellSecondary}>
          {mainValue === "PASSED" ? "无异常" : "暂无补充原因"}
        </div>
      )}
    </div>
  );
}
