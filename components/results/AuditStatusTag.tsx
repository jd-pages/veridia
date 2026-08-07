"use client";

import { Tag } from "antd";
import {
  CheckCircleFilled,
  ClockCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  InfoCircleFilled,
} from "@ant-design/icons";
import { businessStatusLabel } from "@/lib/zh-CN";
import type { StatusLabelDomain } from "@/lib/zh-CN";
import styles from "./results-workbench.module.css";

type Tone = "success" | "danger" | "warning" | "info" | "purple" | "neutral";

const toneByValue: Record<string, Tone> = {
  PASSED: "success",
  COMPLETED: "success",
  COMPLETE: "success",
  NORMAL: "success",
  PRESENT: "success",
  PUBLIC: "success",
  SATISFIED: "success",
  COMPLIANT: "success",
  FAILED: "danger",
  READ_FAILED: "danger",
  EMPTY: "danger",
  NOT_PUBLIC: "danger",
  NOT_SATISFIED: "danger",
  NON_COMPLIANT: "danger",
  NEEDS_REVIEW: "warning",
  PENDING: "warning",
  IMAGES_READ_FAILED: "warning",
  PROCESSING: "info",
  RUNNING: "info",
  IMAGE_TEXT: "info",
  VIDEO_NOTE: "purple",
  VIDEO: "purple",
};

const toneClass: Record<Tone, string> = {
  success: styles.statusSuccess,
  danger: styles.statusDanger,
  warning: styles.statusWarning,
  info: styles.statusInfo,
  purple: styles.statusPurple,
  neutral: styles.statusNeutral,
};

const toneIcon: Record<Tone, React.ReactNode> = {
  success: <CheckCircleFilled />,
  danger: <CloseCircleFilled />,
  warning: <ExclamationCircleFilled />,
  info: <InfoCircleFilled />,
  purple: <ClockCircleFilled />,
  neutral: null,
};

export default function AuditStatusTag({
  value,
  domain = "common",
  label,
  tone,
  icon = false,
}: {
  value: string | null | undefined;
  domain?: StatusLabelDomain;
  label?: string;
  tone?: Tone;
  icon?: boolean;
}) {
  const resolvedTone = tone || toneByValue[value || ""] || "neutral";
  return (
    <Tag
      bordered={false}
      icon={icon ? toneIcon[resolvedTone] : undefined}
      className={`${styles.statusTag} ${toneClass[resolvedTone]}`}
    >
      {label || businessStatusLabel(value, domain)}
    </Tag>
  );
}
