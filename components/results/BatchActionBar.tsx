"use client";

import { Button, Tooltip } from "antd";
import {
  CheckOutlined,
  CloseOutlined,
  DownloadOutlined,
  ReloadOutlined,
  StopOutlined,
} from "@ant-design/icons";
import type { BulkAction } from "./types";
import styles from "./results-workbench.module.css";

export default function BatchActionBar({
  selectedCount,
  onAction,
  onExport,
  onClear,
}: {
  selectedCount: number;
  onAction: (action: BulkAction) => void;
  onExport: () => void;
  onClear: () => void;
}) {
  const disabled = selectedCount === 0;
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
        <Tooltip title="按所选笔记ID使用现有导出接口生成结果">
          <Button
            disabled={disabled}
            icon={<DownloadOutlined />}
            onClick={onExport}
          >
            导出所选
          </Button>
        </Tooltip>
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
