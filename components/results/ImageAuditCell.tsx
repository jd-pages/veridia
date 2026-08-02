"use client";

import type { ResultRow } from "./types";
import AuditStatusTag from "./AuditStatusTag";
import styles from "./results-workbench.module.css";

export default function ImageAuditCell({ row }: { row: ResultRow }) {
  if (["NOT_FOUND", "DELETED"].includes(row.pageStatus)) {
    return (
      <div className={styles.stack}>
        <span className={styles.cellPrimary}>页面失效</span>
        <span className={styles.cellSecondary}>未执行图片数量审核</span>
      </div>
    );
  }
  if (row.noteType === "VIDEO_NOTE" || row.imageStatus === "VIDEO_NOTE") {
    return (
      <div className={styles.stack}>
        <AuditStatusTag value="VIDEO_NOTE" />
        <span className={styles.cellSecondary}>不参与图片数量判断</span>
      </div>
    );
  }
  if (row.imageStatus === "IMAGES_READ_FAILED") {
    return (
      <div className={styles.stack}>
        <span className={styles.cellPrimary}>未能确认</span>
        <AuditStatusTag value="IMAGES_READ_FAILED" label="待人工复核" />
      </div>
    );
  }
  const compliant = row.imageStatus === "COMPLIANT";
  return (
    <div className={styles.stack}>
      <span className={styles.cellPrimary}>
        {row.imageCount === null ? "未能确认" : `${row.imageCount} 张`}
      </span>
      <AuditStatusTag
        value={row.imageStatus}
        label={compliant ? "数量合规" : "数量不足"}
      />
    </div>
  );
}
