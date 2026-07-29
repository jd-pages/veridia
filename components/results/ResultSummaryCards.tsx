"use client";

import {
  AuditOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  UserSwitchOutlined,
} from "@ant-design/icons";
import type { ResultSummary } from "./types";
import styles from "./results-workbench.module.css";

const items = [
  {
    key: "",
    metric: "total" as const,
    label: "结果总数",
    icon: <AuditOutlined />,
    iconClass: styles.summaryIconTotal,
  },
  {
    key: "PASSED",
    metric: "passed" as const,
    label: "审核通过",
    icon: <CheckCircleOutlined />,
    iconClass: styles.summaryIconPassed,
  },
  {
    key: "FAILED",
    metric: "failed" as const,
    label: "审核不通过",
    icon: <CloseCircleOutlined />,
    iconClass: styles.summaryIconFailed,
  },
  {
    key: "NEEDS_REVIEW",
    metric: "review" as const,
    label: "待人工复核",
    icon: <UserSwitchOutlined />,
    iconClass: styles.summaryIconReview,
  },
];

export default function ResultSummaryCards({
  summary,
  activeStatus,
  onSelect,
}: {
  summary: ResultSummary;
  activeStatus: string;
  onSelect: (status: string) => void;
}) {
  return (
    <div className={styles.summaryGrid}>
      {items.map((item) => {
        const value = summary[item.metric];
        const ratio =
          item.metric === "total"
            ? 100
            : summary.total
              ? Math.round((value / summary.total) * 1000) / 10
              : 0;
        return (
          <button
            type="button"
            key={item.metric}
            className={`${styles.summaryCard} ${
              activeStatus === item.key ? styles.summaryCardActive : ""
            }`}
            onClick={() => onSelect(item.key)}
            aria-pressed={activeStatus === item.key}
          >
            <span className={`${styles.summaryIcon} ${item.iconClass}`}>
              {item.icon}
            </span>
            <span className={styles.summaryContent}>
              <span className={styles.summaryLabel}>{item.label}</span>
              <span className={styles.summaryValueLine}>
                <strong className={styles.summaryValue}>{value}</strong>
                <span className={styles.summaryRatio}>
                  {item.metric === "total" ? "当前筛选" : `占比 ${ratio}%`}
                </span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
