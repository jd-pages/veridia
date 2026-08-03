"use client";

import { Button, Drawer, Empty, Space, Spin } from "antd";
import {
  CheckOutlined,
  FileSearchOutlined,
  ReloadOutlined,
  StopOutlined,
} from "@ant-design/icons";
import AuditDecisionSummary from "./AuditDecisionSummary";
import type { BulkAction, ResultDetail, ResultRow } from "./types";
import styles from "./results-workbench.module.css";

export default function AuditDetailDrawer({
  open,
  row,
  detail,
  loading,
  onClose,
  onOpenFullDetail,
  onAction,
  canOperate = true,
}: {
  open: boolean;
  row: ResultRow | null;
  detail: ResultDetail | null;
  loading: boolean;
  onClose: () => void;
  onOpenFullDetail: (row: ResultRow) => void;
  onAction: (row: ResultRow, action: BulkAction) => void;
  canOperate?: boolean;
}) {
  return (
    <Drawer
      open={open}
      width={720}
      title={
        <Space>
          <FileSearchOutlined />
          审核详情
        </Space>
      }
      onClose={onClose}
      destroyOnHidden
      footer={
        row ? (
          <div className={styles.drawerFooter}>
            {canOperate ? (
              <>
                <Button
                  icon={<ReloadOutlined />}
                  onClick={() => onAction(row, "RE_AUDIT")}
                >
                  重新审核
                </Button>
                <Button
                  className={styles.successOutline}
                  icon={<CheckOutlined />}
                  onClick={() => onAction(row, "MANUAL_PASS")}
                >
                  人工通过
                </Button>
                <Button
                  className={styles.dangerOutline}
                  icon={<StopOutlined />}
                  onClick={() => onAction(row, "MANUAL_FAIL")}
                >
                  人工不通过
                </Button>
              </>
            ) : null}
            <Button type="primary" onClick={() => onOpenFullDetail(row)}>
              打开完整详情
            </Button>
          </div>
        ) : null
      }
    >
      {!row ? (
        <Empty description="未选择审核结果" />
      ) : (
        <Spin spinning={loading}>
          <AuditDecisionSummary row={row} detail={detail} />
        </Spin>
      )}
    </Drawer>
  );
}
