import { Tag } from "antd";
import {
  businessStatusLabel,
  type StatusLabelDomain,
} from "@/lib/zh-CN";

const colors: Record<string, string> = {
  ACTIVE: "green",
  INACTIVE: "default",
  PENDING: "gold",
  WAITING: "gold",
  QUEUED: "gold",
  RUNNING: "processing",
  PROCESSING: "processing",
  PAUSED: "default",
  CANCELLED: "default",
  COMPLETED: "blue",
  COMPLETED_WITH_ERRORS: "orange",
  PASSED: "green",
  FAILED: "red",
  NEEDS_REVIEW: "gold",
  READ_FAILED: "volcano",
  NORMAL: "green",
  NOT_FOUND: "red",
  NOTE_NOT_FOUND: "default",
  NO_PERMISSION: "orange",
  LOGIN_EXPIRED: "orange",
  LOGIN_REQUIRED: "orange",
  SECURITY_CHECK: "orange",
  SECURITY_RESTRICTED: "orange",
  NETWORK_ERROR: "orange",
  CHECKING: "processing",
  LOGIN_IN_PROGRESS: "processing",
  READY: "green",
  UNKNOWN: "default",
  DELETED: "red",
  SECURITY_VERIFICATION: "orange",
  NEEDS_CONFIRMATION: "orange",
  PRESENT: "green",
  EMPTY: "red",
  IMAGE_TEXT: "blue",
  VIDEO_NOTE: "purple",
  VIDEO: "purple",
  SUCCESS: "green",
  IMAGES_READ_FAILED: "gold",
  NOT_CHECKED: "default",
  COMPLIANT: "green",
  NON_COMPLIANT: "red",
  NOT_REQUIRED: "default",
  PUBLIC: "green",
  NOT_PUBLIC: "red",
  SATISFIED: "green",
  NOT_SATISFIED: "red",
  ADMIN: "red",
  OPERATOR: "blue",
  VIEWER: "default",
};

export default function StatusTag({
  value,
  domain = "common",
  label,
}: {
  value: string | null | undefined;
  domain?: StatusLabelDomain;
  label?: string;
}) {
  return (
    <Tag color={colors[value || ""] || "default"}>
      {label || businessStatusLabel(value, domain)}
    </Tag>
  );
}
