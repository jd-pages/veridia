"use client";

import { App, Button, Tooltip } from "antd";
import { CopyOutlined, ExportOutlined } from "@ant-design/icons";
import type { ResultRow } from "./types";
import styles from "./results-workbench.module.css";

function compactUrl(value: string) {
  try {
    const url = new URL(value);
    const tail = url.pathname.split("/").filter(Boolean).slice(-1)[0];
    return tail ? `${url.hostname}/…/${tail}` : url.hostname;
  } catch {
    return value;
  }
}

export default function NoteObjectCell({ row }: { row: ResultRow }) {
  const { message } = App.useApp();
  const noteId = row.note.platformNoteId || "未识别笔记ID";
  return (
    <div className={styles.stack}>
      <div className={styles.noteLinkRow}>
        <Tooltip title={row.note.url}>
          <a
            className={styles.noteLink}
            href={row.note.url}
            target="_blank"
            rel="noreferrer"
          >
            {compactUrl(row.note.url)}
          </a>
        </Tooltip>
        <Tooltip title="复制链接">
          <Button
            type="text"
            size="small"
            className={styles.iconButton}
            icon={<CopyOutlined />}
            aria-label="复制链接"
            onClick={async () => {
              await navigator.clipboard.writeText(row.note.url);
              message.success("链接已复制");
            }}
          />
        </Tooltip>
        <Tooltip title="打开原笔记">
          <Button
            type="text"
            size="small"
            className={styles.iconButton}
            icon={<ExportOutlined />}
            aria-label="打开原笔记"
            href={row.note.url}
            target="_blank"
          />
        </Tooltip>
      </div>
      <div className={styles.cellSecondary}>笔记ID：{noteId}</div>
      {row.note.title ? (
        <Tooltip title={row.note.title}>
          <div className={styles.cellSecondary}>{row.note.title}</div>
        </Tooltip>
      ) : null}
    </div>
  );
}
