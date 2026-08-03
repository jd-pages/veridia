"use client";

import { CopyOutlined, ExportOutlined } from "@ant-design/icons";
import { App, Button, Tooltip } from "antd";
import styles from "./results-workbench.module.css";

export default function ResultDetailLink({
  label,
  value,
  variant = "text",
  openText,
  copyText,
}: {
  label: string;
  value: string | null | undefined;
  variant?: "text" | "actions";
  openText?: string;
  copyText?: string;
}) {
  const { message } = App.useApp();

  if (!value) return variant === "actions" ? null : <span>-</span>;

  const copyLink = async () => {
    await navigator.clipboard.writeText(value);
    message.success(`已复制${label}`);
  };

  if (variant === "actions") {
    return (
      <div className={styles.detailLinkActions}>
        <Tooltip title={value}>
          <Button
            icon={<ExportOutlined />}
            href={value}
            target="_blank"
            rel="noreferrer"
            aria-label={openText || `打开${label}`}
          >
            {openText || `打开${label}`}
          </Button>
        </Tooltip>
        <Tooltip title={value}>
          <Button
            icon={<CopyOutlined />}
            aria-label={copyText || `复制${label}`}
            onClick={() => void copyLink()}
          >
            {copyText || `复制${label}`}
          </Button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className={styles.detailLinkRow}>
      <Tooltip title={value}>
        <a
          className={styles.detailLink}
          href={value}
          target="_blank"
          rel="noreferrer"
        >
          {value}
        </a>
      </Tooltip>
      <Tooltip title={`复制${label}`}>
        <Button
          className={styles.iconButton}
          type="text"
          size="small"
          icon={<CopyOutlined />}
          aria-label={`复制${label}`}
          onClick={() => void copyLink()}
        />
      </Tooltip>
      <Tooltip title={`打开${label}`}>
        <Button
          className={styles.iconButton}
          type="text"
          size="small"
          icon={<ExportOutlined />}
          aria-label={`打开${label}`}
          href={value}
          target="_blank"
        />
      </Tooltip>
    </div>
  );
}
