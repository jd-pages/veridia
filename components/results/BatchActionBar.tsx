"use client";

import { Button, Tooltip } from "antd";
import {
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  ReloadOutlined,
  StopOutlined,
} from "@ant-design/icons";
import type { BulkAction } from "./types";
import styles from "./results-workbench.module.css";

export default function BatchActionBar({
  selectedCount,
  canDelete,
  deleting,
  onAction,
  onExport,
  onDelete,
  onClear,
}: {
  selectedCount: number;
  canDelete: boolean;
  deleting: boolean;
  onAction: (action: BulkAction) => void;
  onExport: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const disabled = selectedCount === 0 || deleting;
  return (
    <section
      className={`${styles.batchBar} ${
        selectedCount ? styles.batchBarActive : ""
      }`}
      aria-label="批量操作"
    >
      <div className={styles.selectedCount}>
        已选择 <strong>{selectedCount}</strong> 条
      </div>
      <div className={styles.batchActions}>
        <Button
          disabled={disabled}
          icon={<ReloadOutlined />}
          onClick={() => onAction("RE_AUDIT")}
        >
          批量重新审核
        </Button>
        <Button
          disabled={disabled}
          className={styles.successOutline}
          icon={<CheckOutlined />}
          onClick={() => onAction("MANUAL_PASS")}
        >
          人工通过
        </Button>
        <Button
          disabled={disabled}
          className={styles.dangerOutline}
          icon={<StopOutlined />}
          onClick={() => onAction("MANUAL_FAIL")}
        >
          人工不通过
        </Button>
        <Tooltip title="按所选笔记使用现有导出接口生成结果">
          <Button
            disabled={disabled}
            icon={<DownloadOutlined />}
            onClick={onExport}
          >
            导出所选
          </Button>
        </Tooltip>
        {canDelete && (
          <Button
            danger
            disabled={selectedCount === 0 || deleting}
            icon={<DeleteOutlined />}
            loading={deleting}
            onClick={onDelete}
          >
            批量删除（{selectedCount}）
          </Button>
        )}
        <Button
          type="text"
          disabled={disabled}
          icon={<CloseOutlined />}
          onClick={onClear}
        >
          取消选择
        </Button>
      </div>
    </section>
  );
}
