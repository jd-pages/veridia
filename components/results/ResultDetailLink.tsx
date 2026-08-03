"use client";

import { CopyOutlined, ExportOutlined } from "@ant-design/icons";
import { App, Button, Tooltip } from "antd";
import styles from "./results-workbench.module.css";

export default function ResultDetailLink({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  const { message } = App.useApp();

  if (!value) return <span>-</span>;

  const copyLink = async () => {
    await navigator.clipboard.writeText(value);
    message.success(`已复制${label}`);
  };

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
