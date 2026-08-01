"use client";

import {
  Button,
  Collapse,
  Descriptions,
  Drawer,
  Empty,
  Space,
  Spin,
  Timeline,
  Typography,
} from "antd";
import {
  CheckOutlined,
  ExportOutlined,
  FileSearchOutlined,
  ReloadOutlined,
  StopOutlined,
} from "@ant-design/icons";
import {
  businessEvidenceLabel,
  businessFailureReasonLabel,
  businessTextLabel,
} from "@/lib/zh-CN";
import { parseJsonArray } from "@/lib/client";
import { productStageTopicLabel } from "@/lib/product-stage";
import AuditConclusionCell from "./AuditConclusionCell";
import AuditStatusTag from "./AuditStatusTag";
import ImageAuditCell from "./ImageAuditCell";
import TopicAuditCell from "./TopicAuditCell";
import type { BulkAction, ResultDetail, ResultRow } from "./types";
import styles from "./results-workbench.module.css";

function DrawerSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className={styles.drawerSection}>
      <h3 className={styles.drawerSectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

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
      width={680}
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
            <Button
              icon={<ExportOutlined />}
              href={row.note.url}
              target="_blank"
            >
              打开原笔记
            </Button>
            {canOperate && (
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
            )}
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
          <div className={styles.drawerHeaderResult}>
            <AuditConclusionCell row={row} />
          </div>

          <DrawerSection title="笔记基础信息">
            <Descriptions
              size="small"
              bordered
              column={2}
              items={[
                {
                  key: "noteId",
                  label: "笔记ID",
                  children: row.note.platformNoteId || "未识别",
                },
                {
                  key: "ruleVersion",
                  label: "规则版本",
                  children: `v${row.ruleVersion}`,
                },
                {
                  key: "product",
                  label: "产品",
                  children: row.task.product.name,
                },
                {
                  key: "campaign",
                  label: "活动",
                  children: row.task.campaign.name,
                },
                {
                  key: "stage",
                  label: "产品阶段话题",
                  children: productStageTopicLabel(row.task.productStage),
                },
                {
                  key: "auditedAt",
                  label: "审核时间",
                  children: new Date(row.auditedAt).toLocaleString("zh-CN"),
                },
              ]}
            />
          </DrawerSection>

          <DrawerSection title="页面与正文状态">
            <Space size={[6, 6]} wrap>
              <AuditStatusTag value={row.pageStatus} />
              <AuditStatusTag value={row.bodyStatus} />
              <AuditStatusTag value={row.noteType} />
              <AuditStatusTag value={row.publicStatus} />
              <AuditStatusTag value={row.retentionStatus} />
            </Space>
            <div className={styles.cellSecondary}>
              有效正文字数：{row.effectiveBodyLength ?? 0} 个字符
            </div>
          </DrawerSection>

          <DrawerSection title="话题审核详情">
            <TopicAuditCell row={row} />
          </DrawerSection>

          <DrawerSection title="图片数量状态">
            <ImageAuditCell row={row} />
          </DrawerSection>

          <DrawerSection title="自动审核与人工复核">
            <Descriptions
              size="small"
              bordered
              column={1}
              items={[
                {
                  key: "process",
                  label: "处理状态",
                  children: (
                    <AuditStatusTag value={row.task.status} domain="process" />
                  ),
                },
                {
                  key: "auto",
                  label: "自动审核结果",
                  children: (
                    <AuditStatusTag value={row.autoStatus} domain="audit" />
                  ),
                },
                {
                  key: "exception",
                  label: "异常分类",
                  children: row.task.failureCode
                    ? businessFailureReasonLabel(row.task.failureCode)
                    : "无异常",
                },
                {
                  key: "failureMessage",
                  label: "失败原因",
                  children:
                    row.task.failureMessage ||
                    parseJsonArray(row.failureReasons)
                      .map(businessFailureReasonLabel)
                      .join("；") ||
                    "无异常",
                },
                {
                  key: "attempts",
                  label: "尝试次数",
                  children: row.task.attempts,
                },
                {
                  key: "manual",
                  label: "人工复核结果",
                  children: row.manualReviews[0] ? (
                    <AuditStatusTag
                      value={row.manualReviews[0].result}
                      domain="audit"
                      label={
                        row.manualReviews[0].result === "PASSED"
                          ? "人工通过"
                          : "人工不通过"
                      }
                    />
                  ) : (
                    "尚未复核"
                  ),
                },
                {
                  key: "reasons",
                  label: "异常或失败原因",
                  children:
                    parseJsonArray(row.failureReasons)
                      .map(businessFailureReasonLabel)
                      .join("；") || "无异常",
                },
              ]}
            />
          </DrawerSection>

          <DrawerSection title="操作记录">
            {detail?.operationLogs.length ? (
              <Timeline
                items={detail.operationLogs.slice(0, 8).map((log) => ({
                  children: (
                    <>
                      <strong>{businessTextLabel(log.summary)}</strong>
                      <div className={styles.cellSecondary}>
                        {log.user?.displayName || "系统"} ·{" "}
                        {new Date(log.createdAt).toLocaleString("zh-CN")}
                      </div>
                    </>
                  ),
                }))}
              />
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="暂无操作记录"
              />
            )}
          </DrawerSection>

          {detail ? (
            <Collapse
              size="small"
              items={[
                {
                  key: "rules",
                  label: "逐条规则审核证据",
                  children: (
                    <div className={styles.stack}>
                      {detail.ruleResults.map((rule) => (
                        <div key={rule.id}>
                          <strong>{rule.ruleName}</strong>
                          <div className={styles.cellSecondary}>
                            {rule.passed ? "通过" : "不通过"} ·{" "}
                            {businessEvidenceLabel(rule.evidence)}
                          </div>
                        </div>
                      ))}
                    </div>
                  ),
                },
                {
                  key: "raw",
                  label: "原始 JSON 与页面证据（默认折叠）",
                  children: (
                    <Typography.Text>
                      <pre className={styles.drawerRaw}>
                        {detail.note.extractions[0]?.rawData || "暂无原始数据"}
                      </pre>
                    </Typography.Text>
                  ),
                },
              ]}
            />
          ) : null}
        </Spin>
      )}
    </Drawer>
  );
}
