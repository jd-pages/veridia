"use client";

import { memo } from "react";
import type { ResultRow } from "./types";
import AuditStatusTag from "./AuditStatusTag";
import styles from "./results-workbench.module.css";

function ImageAuditCell({ row }: { row: ResultRow }) {
  if (row.presentation.image.label === "未审核") {
    return (
      <span className={styles.cellPrimary}>
        {row.presentation.image.label}
      </span>
    );
  }
  if (row.presentation.image.status === "VIDEO_NOTE") {
    return (
      <div className={styles.stack}>
        <AuditStatusTag value="VIDEO_NOTE" />
        <span className={styles.cellSecondary}>不参与图片数量判断</span>
      </div>
    );
  }
  if (row.presentation.image.status === "IMAGES_READ_FAILED") {
    return (
      <div className={styles.stack}>
        <span className={styles.cellPrimary}>未能确认</span>
        <AuditStatusTag value="IMAGES_READ_FAILED" label="待人工复核" />
      </div>
    );
  }
  return (
    <div className={styles.stack}>
      <span className={styles.cellPrimary}>
        {row.imageCount === null ? "未能确认" : `${row.imageCount} 张`}
      </span>
      <AuditStatusTag
        value={row.presentation.image.status}
        label={row.presentation.image.label}
      />
    </div>
  );
}

export default memo(ImageAuditCell);
