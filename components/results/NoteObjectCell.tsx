"use client";

import { Tooltip } from "antd";
import { resultDetailLinks } from "@/lib/result-links";
import ResultDetailLink from "./ResultDetailLink";
import type { ResultRow } from "./types";
import styles from "./results-workbench.module.css";

export default function NoteObjectCell({ row }: { row: ResultRow }) {
  const noteId = row.note.platformNoteId || "未识别笔记ID";
  const links = resultDetailLinks(row);

  return (
    <div className={styles.stack}>
      <div className={styles.notePrimaryLink}>
        <ResultDetailLink label="原笔记链接" value={links.originalUrl} />
      </div>
      <div className={styles.noteFinalLinkRow}>
        <span className={styles.noteFinalLinkLabel}>最终链接：</span>
        <div className={styles.noteFinalLinkValue}>
          <ResultDetailLink label="最终链接" value={links.finalUrl} />
        </div>
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
