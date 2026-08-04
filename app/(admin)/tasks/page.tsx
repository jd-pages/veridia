"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Dropdown,
  Form,
  Input,
  Progress,
  Result,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Upload,
} from "antd";
import {
  AuditOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  DatabaseOutlined,
  DownloadOutlined,
  FileSearchOutlined,
  InboxOutlined,
  LoginOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RetweetOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
  SyncOutlined,
  UserSwitchOutlined,
} from "@ant-design/icons";
import type { UploadFile } from "antd";
import PageHeader from "@/components/PageHeader";
import { apiFetch } from "@/lib/client";
import {
  downloadImportTemplate,
  type ImportTemplateFormat,
} from "@/lib/import-template-download-client";
import {
  PRODUCT_STAGE_TOPIC_OPTIONS,
  productStageTopicLabel,
  stageTopicsForProductStage,
} from "@/lib/product-stage";
import {
  businessPageTypeLabel,
  businessFailureReasonLabel,
  businessSourceLabel,
  businessStatusLabel,
  businessUiText,
  pageLinkLabels,
  type StatusLabelDomain,
} from "@/lib/zh-CN";
import styles from "./tasks.module.css";
import type { SessionUser } from "@/lib/auth";
import { canAccessBusiness } from "@/lib/permissions";
import { extractNoteLinksFromText } from "@/lib/note-links";

interface Product {
  id: string;
  code: string | null;
  name: string;
}

interface Campaign {
  id: string;
  name: string;
  month: string;
  productId: string | null;
  products?: Array<{ product: Product }>;
}

interface AuditRequirements {
  context: {
    minImageCount: number;
    minBodyLength: number;
    publicRequired: boolean;
    retentionDays: number;
    productStage: string | null;
    bodyStageRequired?: boolean;
    milkType: string | null;
    rules: Array<{
      id: string;
      topic: string;
      topicCategory?: string | null;
      applicableStage?: string | null;
      exactMatch: boolean;
      clickableRequired: boolean;
    }>;
  };
  product: Product & { contentDirection: string | null };
  stages: string[];
  contentDirection: string | null;
}

interface Task {
  id: string;
  batchId: string | null;
  url: string;
  finalUrl: string | null;
  pageTitle: string | null;
  pageType: string | null;
  failureEvidence: string | null;
  source: string;
  status: string;
  productStage: string | null;
  queueOrder: number;
  attempts: number;
  failureCode: string | null;
  failureMessage: string | null;
  notes: string | null;
  createdAt: string;
  finishedAt: string | null;
  product: Product;
  campaign: Campaign;
  auditResults: Array<{
    id: string;
    autoStatus: string;
    bodyCompliant?: boolean;
    topicsCompliant?: boolean;
    clickableCompliant?: boolean;
  }>;
}

interface BatchStats {
  total: number;
  waiting: number;
  processing: number;
  succeeded: number;
  failed: number;
  readFailed: number;
  loginExpired: number;
  needsReview: number;
  cancelled: number;
  completed: number;
  remaining: number;
  progress: number;
}

interface AuditBatch {
  id: string;
  name: string | null;
  source: string;
  status: string;
  productStage: string | null;
  createdAt: string;
  finishedAt: string | null;
  product: Product | null;
  campaign: Campaign | null;
  stats: BatchStats;
  tasks: Task[];
  currentTask: Task | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

interface AutomationSession {
  status: string;
  lastLoginAt: string | null;
  lastError: string | null;
}

interface ImportPreview {
  total: number;
  validCount: number;
  invalidCount: number;
  imported: number;
  batchId?: string | null;
  templateVersion: string;
  sourceType: string;
  recognizedFields: Array<{
    header: string;
    field: string;
    displayName: string;
  }>;
  unknownHeaders: string[];
  missingRequiredFields: string[];
  duplicateHeaders: string[];
  previewRows: Array<{
    rowNumber: number;
    values: Record<string, string>;
    errors: string[];
  }>;
  rows: Array<{
    rowNumber: number;
    url: string;
    originalLinkContent: string;
    contentChannel: string;
    platform: string;
    recognitionStatus: string;
    failureReason: string;
    productName: string;
    campaignName: string;
    productStage: string;
    stageGroup: string;
    errors: string[];
  }>;
}

const activeBatchStatuses = new Set([
  "QUEUED",
  "RUNNING",
  "PAUSED",
  "LOGIN_EXPIRED",
]);

const governanceTone: Record<
  string,
  "success" | "danger" | "warning" | "info" | "neutral"
> = {
  PASSED: "success",
  COMPLETED: "success",
  READY: "success",
  FAILED: "danger",
  READ_FAILED: "danger",
  COMPLETED_WITH_ERRORS: "warning",
  NEEDS_REVIEW: "warning",
  LOGIN_EXPIRED: "warning",
  PAUSED: "warning",
  RUNNING: "info",
  PROCESSING: "info",
  LOGIN_IN_PROGRESS: "info",
  QUEUED: "neutral",
  PENDING: "neutral",
  CANCELLED: "neutral",
  UNKNOWN: "neutral",
};

function GovernanceStatus({
  value,
  domain = "common",
}: {
  value: string | null | undefined;
  domain?: StatusLabelDomain;
}) {
  const tone = governanceTone[value || ""] || "neutral";
  return (
    <span
      className={`${styles.statusPill} ${styles[tone]}`}
      title={businessStatusLabel(value, domain)}
    >
      {businessStatusLabel(value, domain)}
    </span>
  );
}

function EvidencePill({ label }: { label: string }) {
  return <span className={styles.evidencePill}>{label}</span>;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function rememberCurrentBatch(batchId: string | undefined) {
  const url = new URL(window.location.href);
  if (batchId) url.searchParams.set("batchId", batchId);
  else url.searchParams.delete("batchId");
  window.history.replaceState(window.history.state, "", url);
}

export default function TasksPage() {
  const { message } = App.useApp();
  const [products, setProducts] = useState<Product[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [batches, setBatches] = useState<AuditBatch[]>([]);
  const [session, setSession] = useState<AutomationSession | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const selectedProduct = Form.useWatch("productId", form);
  const selectedCampaign = Form.useWatch("campaignId", form);
  const selectedStage = Form.useWatch("productStage", form);
  const rawNoteLinks = Form.useWatch("urls", form) || "";
  const linkPreview = useMemo(
    () => extractNoteLinksFromText(rawNoteLinks),
    [rawNoteLinks],
  );
  const [requirements, setRequirements] = useState<AuditRequirements | null>(
    null,
  );
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importing, setImporting] = useState(false);
  const [templateDownloading, setTemplateDownloading] = useState(false);
  const [currentRole, setCurrentRole] = useState<SessionUser["role"] | null>(
    null,
  );
  const canOperate = canAccessBusiness(currentRole);

  const load = useCallback(async (quiet = false, targetBatchId?: string) => {
    if (!quiet) setLoading(true);
    const batchQuery = targetBatchId
      ? `?batchId=${encodeURIComponent(targetBatchId)}`
      : "?limit=1";
    const [productResult, campaignResult, batchResult, sessionResult] =
      await Promise.allSettled([
        apiFetch<Product[]>("/api/products"),
        apiFetch<Campaign[]>("/api/campaigns"),
        apiFetch<AuditBatch[]>(`/api/automation/batches${batchQuery}`),
        apiFetch<AutomationSession>("/api/automation/session"),
      ]);
    if (productResult.status === "fulfilled") setProducts(productResult.value);
    if (campaignResult.status === "fulfilled") setCampaigns(campaignResult.value);
    if (batchResult.status === "fulfilled") {
      const currentBatch = batchResult.value[0];
      setBatches(currentBatch ? [currentBatch] : []);
      setSelectedBatchId(currentBatch?.id);
      rememberCurrentBatch(currentBatch?.id);
      if (currentBatch) {
        try {
          const currentTasks = await apiFetch<Task[]>(
            `/api/tasks?batchId=${encodeURIComponent(currentBatch.id)}`,
          );
          setTasks(currentTasks);
        } catch (error) {
          setTasks([]);
          if (!quiet) {
            message.error(
              error instanceof Error
                ? error.message
                : "读取本次任务内容失败，请刷新重试。",
            );
          }
        }
      } else {
        setTasks([]);
      }
    }
    if (sessionResult.status === "fulfilled") {
      setSession(sessionResult.value);
    } else {
      setSession({ status: "LOGIN_REQUIRED", lastLoginAt: null, lastError: null });
    }
    const dataFailure = [
      productResult,
      campaignResult,
      batchResult,
    ].find((result) => result.status === "rejected");
    if (!quiet && dataFailure?.status === "rejected") {
      message.error(
        dataFailure.reason instanceof Error
          ? dataFailure.reason.message
          : "数据读取失败，请刷新或重启 VERIDIA。",
      );
    }
    if (!quiet) setLoading(false);
  }, [message]);

  useEffect(() => {
    const requestedBatchId =
      new URLSearchParams(window.location.search).get("batchId") || undefined;
    void load(false, requestedBatchId);
    void apiFetch<SessionUser | null>("/api/auth/me").then((user) =>
      setCurrentRole(user?.role || null),
    );
  }, [load]);

  useEffect(() => {
    if (!selectedProduct || !selectedCampaign || !selectedStage) {
      setRequirements(null);
      return;
    }
    let cancelled = false;
    apiFetch<AuditRequirements>(
      `/api/campaigns/${selectedCampaign}/requirements?productId=${encodeURIComponent(selectedProduct)}&stage=${encodeURIComponent(selectedStage)}`,
    )
      .then((result) => {
        if (!cancelled) setRequirements(result);
      })
      .catch((error) => {
        if (!cancelled) {
          setRequirements(null);
          message.error(
            error instanceof Error ? error.message : "加载本次审核要求失败",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [message, selectedCampaign, selectedProduct, selectedStage]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (batches.some((batch) => activeBatchStatuses.has(batch.status))) {
        void load(true, selectedBatchId);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [batches, load, selectedBatchId]);

  const selectedBatch = useMemo(
    () => batches.find((batch) => batch.id === selectedBatchId) || batches[0],
    [batches, selectedBatchId],
  );
  const currentTaskSummary = useMemo(() => {
    const statuses = tasks.map((task) => task.auditResults[0]?.autoStatus);
    return {
      passed: statuses.filter((status) => status === "PASSED").length,
      failed: statuses.filter((status) => status === "FAILED").length,
      needsReview: statuses.filter(
        (status) => status === "NEEDS_REVIEW" || status === "READ_FAILED",
      ).length,
    };
  }, [tasks]);
  const requiredStageTopics = useMemo(
    () => requirements
      ? stageTopicsForProductStage(
          requirements.context.rules,
          requirements.context.productStage,
        )
      : [],
    [requirements],
  );

  const createBatch = async (values: {
    name?: string;
    productId: string;
    campaignId: string;
    productStage: string;
    urls: string;
    notes?: string;
  }) => {
    setSubmitting(true);
    try {
      const result = await apiFetch<{
        batchId: string;
        created: number;
        skipped: Array<{ url: string; reason: string }>;
        recognizedCount: number;
        deduplicatedCount: number;
        duplicateCount: number;
        unrecognized: Array<{ input: string; reason: string }>;
      }>("/api/automation/batches", {
        method: "POST",
        body: JSON.stringify(values),
      });
      setSelectedBatchId(result.batchId);
      message.success(
        result.skipped.length
          ? `已创建 ${result.created} 条，跳过 ${result.skipped.length} 条重复链接，自动审核已开始`
          : `已创建 ${result.created} 条任务，自动审核已开始`,
      );
      if (result.unrecognized.length) {
        message.warning(
          `${result.unrecognized.length} 段内容未识别到有效小红书链接，其他有效链接已正常创建`,
        );
      }
      form.setFieldValue("urls", "");
      await load(true, result.batchId);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "创建批次失败");
    } finally {
      setSubmitting(false);
    }
  };

  const submitExcel = async (commit: boolean) => {
    const file = fileList[0]?.originFileObj;
    if (!file) {
      message.warning("请先选择 Excel、CSV 或腾讯文档导出的表格");
      return;
    }
    setImporting(true);
    try {
      const data = new FormData();
      data.append("file", file);
      data.append("commit", String(commit));
      data.append("skipDuplicates", "true");
      const result = await apiFetch<ImportPreview>("/api/import/notes", {
        method: "POST",
        body: data,
      });
      setPreview(result);
      if (commit) {
        if (result.batchId) setSelectedBatchId(result.batchId);
        message.success(`已导入 ${result.imported} 条，自动审核已开始`);
        await load(true, result.batchId || undefined);
      } else {
        message.success("预检查完成");
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "表格处理失败");
    } finally {
      setImporting(false);
    }
  };

  const controlBatch = async (
    action: "PAUSE" | "CONTINUE" | "CANCEL" | "RETRY_FAILED",
  ) => {
    if (!selectedBatch) return;
    try {
      await apiFetch(`/api/automation/batches/${selectedBatch.id}/control`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      message.success(
        {
          PAUSE: "已请求暂停，当前链接处理完成后停止",
          CONTINUE: "队列已继续",
          CANCEL: "剩余任务已取消",
          RETRY_FAILED: "失败任务已重新入队",
        }[action],
      );
      await load(true, selectedBatch.id);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "队列操作失败");
    }
  };

  const loginAction = async (action: "START_LOGIN" | "COMPLETE_LOGIN") => {
    try {
      const result = await apiFetch<AutomationSession>("/api/automation/session", {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      setSession(result);
      if (action === "START_LOGIN") {
        message.info("专用浏览器已打开，请手动登录或扫码");
      } else if (result.status === "READY") {
        message.success("登录状态已保存，可以继续自动审核");
      } else {
        message.warning(result.lastError || "尚未识别到有效登录状态");
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "登录操作失败");
    }
  };

  const downloadTemplate = async (format: ImportTemplateFormat) => {
    if (templateDownloading) return;
    setTemplateDownloading(true);
    try {
      const result = await downloadImportTemplate(format);
      if (result.saved) message.success(`导入模板已保存：${result.fileName}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "下载导入模板失败");
    } finally {
      setTemplateDownloading(false);
    }
  };

  return (
    <div className={styles.tasksWorkspace}>
      <PageHeader
        title="审核任务"
        description="配置自动审核策略、监控执行进度并处理异常任务"
        actions={
          <Space>
            <Dropdown
              menu={{
                items: [
                  {
                    key: "xlsx",
                    label: "导出审核结果 Excel",
                    onClick: () =>
                      window.open("/api/results/export?format=xlsx", "_blank"),
                  },
                  {
                    key: "csv",
                    label: "导出审核结果 CSV",
                    onClick: () =>
                      window.open("/api/results/export?format=csv", "_blank"),
                  },
                  {
                    key: "tasks-xlsx",
                    label: "导出任务列表 Excel",
                    onClick: () =>
                      window.open("/api/tasks/export?format=xlsx", "_blank"),
                  },
                  {
                    key: "tasks-csv",
                    label: "导出任务列表 CSV",
                    onClick: () =>
                      window.open("/api/tasks/export?format=csv", "_blank"),
                  },
                ],
              }}
              disabled={!canOperate}
            >
              <Button icon={<DownloadOutlined />}>导出</Button>
            </Dropdown>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新数据
            </Button>
          </Space>
        }
      />

      <Card
        bordered={false}
        className={`${styles.consoleCard} ${styles.sessionCard}`}
      >
        <div className={styles.sessionIdentity}>
          <span className={styles.sessionIcon}>
            <SafetyCertificateOutlined />
          </span>
          <div>
            <span className={styles.eyebrow}>
              {businessUiText.secureBrowserSession}
            </span>
            <div className={styles.sessionTitle}>
              <strong>小红书专用浏览器</strong>
              <GovernanceStatus
                value={session?.status || "UNKNOWN"}
                domain="session"
              />
            </div>
            <p>
              {session?.lastLoginAt
                ? `最近登录 ${new Date(session.lastLoginAt).toLocaleString("zh-CN")}`
                : "尚未保存可复用的登录状态"}
            </p>
            {session?.lastError ? (
              <span className={styles.inlineError}>{session.lastError}</span>
            ) : null}
          </div>
        </div>
        {canOperate && <Space wrap>
          <Button
            icon={<LoginOutlined />}
            onClick={() => void loginAction("START_LOGIN")}
          >
            登录小红书
          </Button>
          <Button
            type="primary"
            onClick={() => void loginAction("COMPLETE_LOGIN")}
          >
            我已完成登录
          </Button>
        </Space>}
      </Card>

      {canOperate && <Tabs
        className={styles.modeTabs}
        defaultActiveKey="automatic"
        items={[
          {
            key: "automatic",
            label: "自动批量审核",
            children: (
              <Card
                bordered={false}
                className={`${styles.consoleCard} ${styles.configCard}`}
              >
                <div className={styles.sectionHeader}>
                  <div>
                    <span className={styles.eyebrow}>
                      {businessUiText.taskConfiguration}
                    </span>
                    <h2>创建审核任务</h2>
                    <p>选择治理规则并提交链接，系统将按队列逐条完成审核。</p>
                  </div>
                </div>
                <Form
                  form={form}
                  className={styles.configForm}
                  layout="vertical"
                  onFinish={(values) => void createBatch(values)}
                >
                      <Form.Item name="name" label="批次名称">
                        <Input placeholder="例如：7月达人笔记第一批" />
                      </Form.Item>
                      <Row gutter={16}>
                        <Col xs={24} md={12}>
                          <Form.Item
                            name="productId"
                            label="所属产品"
                            rules={[{ required: true }]}
                          >
                            <Select
                              showSearch
                              optionFilterProp="label"
                              placeholder="选择产品"
                              options={products.map((item) => ({
                                value: item.id,
                                label: item.code
                                  ? `${item.code} · ${item.name}`
                                  : item.name,
                              }))}
                              onChange={() => {
                                form.setFieldValue("campaignId", undefined);
                                form.setFieldValue("productStage", undefined);
                              }}
                            />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={12}>
                          <Form.Item
                            name="campaignId"
                            label="所属活动"
                            rules={[{ required: true }]}
                          >
                            <Select
                              showSearch
                              optionFilterProp="label"
                              placeholder="选择活动"
                              onChange={() =>
                                form.setFieldValue("productStage", undefined)
                              }
                              options={campaigns
                                .filter(
                                  (item) =>
                                    item.productId === selectedProduct ||
                                    item.products?.some(
                                      ({ product }) =>
                                        product.id === selectedProduct,
                                    ),
                                )
                                .map((item) => ({
                                  value: item.id,
                                  label: `${item.month} · ${item.name}`,
                                }))}
                            />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Form.Item
                        name="productStage"
                        label="产品阶段话题"
                        rules={[{ required: true }]}
                        extra="请选择 IFFO 或 GUM。"
                      >
                        <Select
                          placeholder="选择产品阶段话题"
                          options={PRODUCT_STAGE_TOPIC_OPTIONS.map((item) => ({
                            value: item.value,
                            label: item.label,
                          }))}
                        />
                      </Form.Item>
                      {requirements ? (
                        <Alert
                          showIcon
                          type="info"
                          className={styles.requirementsAlert}
                          message={`当前规则集 · ${requirements.product.name} · ${productStageTopicLabel(requirements.context.productStage)}`}
                          description={
                            <Space direction="vertical" size={5}>
                              <span>
                                图文笔记至少 {requirements.context.minImageCount} 张图片；
                                有效正文至少 {requirements.context.minBodyLength} 字；
                                {requirements.context.publicRequired
                                  ? `公开并保留 ${requirements.context.retentionDays} 天`
                                  : "不要求公开"}
                              </span>
                              <span>
                                要求阶段话题：
                                {requiredStageTopics.length
                                  ? requiredStageTopics.join(" / ")
                                  : "未配置"}
                              </span>
                              <span>
                                可点击话题：
                                {requirements.context.rules
                                  .map((rule) => rule.topic)
                                  .join("、")}
                              </span>
                              <span>
                                内容参考：
                                {requirements.contentDirection || "无"}
                                （仅作人工复核依据）
                              </span>
                            </Space>
                          }
                        />
                      ) : null}
                      <Form.Item
                        name="urls"
                        label="小红书笔记链接"
                        rules={[{ required: true }]}
                        extra={
                          <Space direction="vertical" size={2}>
                            <span>
                              也支持粘贴“标题 + 链接 + 说明文字”，系统会自动提取链接；后台默认单线程处理。
                            </span>
                            {rawNoteLinks.trim() ? (
                              <span>
                                识别到 {linkPreview.recognizedCount} 条有效链接，去重后 {linkPreview.links.length} 条
                                {linkPreview.duplicateCount
                                  ? `，重复 ${linkPreview.duplicateCount} 条`
                                  : ""}
                                ，未识别内容 {linkPreview.unrecognized.length} 段。
                              </span>
                            ) : null}
                          </Space>
                        }
                      >
                        <Input.TextArea
                          rows={7}
                          placeholder={"https://www.xiaohongshu.com/explore/xxxx\nhttp://xhslink.com/o/xxxx\nhttp://xhslink.cn/o/xxxx"}
                        />
                      </Form.Item>
                      <Form.Item name="notes" label="内部备注">
                        <Input placeholder="可选，仅用于内部任务识别" />
                      </Form.Item>
                      <Button
                        type="primary"
                        size="large"
                        htmlType="submit"
                        loading={submitting}
                        icon={<PlayCircleOutlined />}
                        className={styles.primaryAction}
                      >
                        创建审核任务
                      </Button>
                </Form>
              </Card>
            ),
          },
          {
            key: "excel",
            label: "Excel 自动审核",
            children: (
              <Card bordered={false} className={styles.consoleCard}>
                <div className={styles.sectionHeader}>
                  <div>
                    <span className={styles.eyebrow}>
                      {businessUiText.bulkIngestion}
                    </span>
                    <h2>表格批量导入</h2>
                    <p>
                      支持 Excel / CSV，也支持从腾讯文档导出的表格文件；字段别名会自动识别，表头顺序可不同。
                    </p>
                  </div>
                  <Dropdown
                    menu={{
                      items: [
                        {
                          key: "xlsx",
                          label: "下载 Excel 模板",
                          onClick: () => void downloadTemplate("xlsx"),
                        },
                        {
                          key: "csv",
                          label: "下载 CSV 模板",
                          onClick: () => void downloadTemplate("csv"),
                        },
                      ],
                    }}
                  >
                    <Button
                      icon={<DownloadOutlined />}
                      loading={templateDownloading}
                    >
                      下载导入模板
                    </Button>
                  </Dropdown>
                </div>
                <Space
                  className={styles.excelImportStack}
                  direction="vertical"
                  size={18}
                  style={{ width: "100%" }}
                >
                  <Upload.Dragger
                    className={styles.uploadArea}
                    accept=".xlsx,.xls,.csv"
                    maxCount={1}
                    fileList={fileList}
                    beforeUpload={() => false}
                    onChange={({ fileList: next }) => {
                      setFileList(next.slice(-1));
                      setPreview(null);
                    }}
                  >
                    <p className="ant-upload-drag-icon">
                      <InboxOutlined />
                    </p>
                    <p className="ant-upload-text">
                      点击或拖入 Excel / CSV 表格
                    </p>
                    <p className="ant-upload-hint">
                      支持腾讯文档导出文件；模板版本随审核规则同步更新
                    </p>
                  </Upload.Dragger>
                  <Space wrap>
                    <Button
                      loading={importing}
                      onClick={() => void submitExcel(false)}
                    >
                      开始预检查
                    </Button>
                    <Button
                      type="primary"
                      loading={importing}
                      disabled={!preview || preview.validCount === 0}
                      onClick={() => void submitExcel(true)}
                    >
                      导入并自动审核 {preview?.validCount || 0} 条
                    </Button>
                  </Space>
                  {preview ? (
                    <>
                      <Alert
                        type={preview.invalidCount ? "warning" : "success"}
                        showIcon
                        message={`可导入 ${preview.validCount} 条，异常 ${preview.invalidCount} 条`}
                        description="预览阶段不会写入数据库；确认导入后使用事务创建任务。"
                      />
                      <Descriptions
                        size="small"
                        bordered
                        column={{ xs: 1, md: 2, xl: 4 }}
                      >
                        <Descriptions.Item label="模板版本">
                          {preview.templateVersion}
                        </Descriptions.Item>
                        <Descriptions.Item label="数据源类型">
                          {preview.sourceType}
                        </Descriptions.Item>
                        <Descriptions.Item label="识别字段">
                          {preview.recognizedFields
                            .map((item) => item.displayName)
                            .join("、") || "无"}
                        </Descriptions.Item>
                        <Descriptions.Item label="未识别字段">
                          {preview.unknownHeaders.join("、") || "无"}
                        </Descriptions.Item>
                        <Descriptions.Item label="缺少必填字段">
                          {preview.missingRequiredFields.join("、") || "无"}
                        </Descriptions.Item>
                        <Descriptions.Item label="重复表头">
                          {preview.duplicateHeaders.join("、") || "无"}
                        </Descriptions.Item>
                      </Descriptions>
                      <div className={styles.previewTableShell}>
                        <Table<ImportPreview["rows"][number]>
                          className={styles.enterpriseTable}
                          rowKey="rowNumber"
                          size="small"
                          dataSource={preview.rows}
                          tableLayout="fixed"
                          scroll={{ x: 1500 }}
                        columns={[
                          { title: "行", dataIndex: "rowNumber", width: 70 },
                          {
                            title: "原始链接内容",
                            dataIndex: "originalLinkContent",
                            width: 210,
                            render: (value: string) => (
                              <span
                                className={styles.previewEllipsis}
                                title={value}
                              >
                                {value || "-"}
                              </span>
                            ),
                          },
                          {
                            title: "提取后的真实链接",
                            dataIndex: "url",
                            width: 230,
                            render: (value: string) => (
                              <span
                                className={styles.previewEllipsis}
                                title={value}
                              >
                                {value || "-"}
                              </span>
                            ),
                          },
                          {
                            title: "识别状态",
                            dataIndex: "recognitionStatus",
                            width: 110,
                            render: (value: string) =>
                              value === "RECOGNIZED" ? (
                                <Tag color="green">已识别</Tag>
                              ) : value === "UNSUPPORTED" ? (
                                <Tag color="orange">暂不支持</Tag>
                              ) : (
                                <Tag color="red">识别失败</Tag>
                              ),
                          },
                          {
                            title: "链接识别说明",
                            dataIndex: "failureReason",
                            width: 190,
                            render: (value: string) => (
                              <span
                                className={styles.previewEllipsis}
                                title={value}
                              >
                                {value || "-"}
                              </span>
                            ),
                          },
                          {
                            title: "产品",
                            dataIndex: "productName",
                            width: 150,
                            render: (value: string) => (
                              <span
                                className={styles.previewEllipsis}
                                title={value}
                              >
                                {value || "-"}
                              </span>
                            ),
                          },
                          {
                            title: "活动",
                            dataIndex: "campaignName",
                            width: 190,
                            render: (value: string) => (
                              <span className={styles.previewWrap} title={value}>
                                {value || "-"}
                              </span>
                            ),
                          },
                          {
                            title: (
                              <span className={styles.previewHeaderWrap}>
                                产品阶段话题
                              </span>
                            ),
                            width: 130,
                            align: "center",
                            render: (_value, row) =>
                              row.productStage ? (
                                <span className={styles.stageTopicCell}>
                                  <Tag>
                                    {row.stageGroup ||
                                      productStageTopicLabel(row.productStage)}
                                  </Tag>
                                </span>
                              ) : (
                                "-"
                              ),
                          },
                          {
                            title: "预检结果",
                            dataIndex: "errors",
                            width: 220,
                            render: (errors: string[]) =>
                              errors.length ? (
                                <span
                                  className={`${styles.errorText} ${styles.previewResult}`}
                                  title={errors.join("；")}
                                >
                                  {errors.join("；")}
                                </span>
                              ) : (
                                <GovernanceStatus value="PASSED" domain="audit" />
                              ),
                          },
                        ]}
                          pagination={{
                            pageSize: 8,
                            showSizeChanger: false,
                            position: ["bottomRight"],
                          }}
                        />
                      </div>
                    </>
                  ) : null}
                </Space>
              </Card>
            ),
          },
          {
            key: "plugin",
            label: "插件人工补审",
            children: (
              <Card bordered={false} className={styles.consoleCard}>
                <div className={styles.sectionHeader}>
                  <div>
                    <span className={styles.eyebrow}>
                      {businessUiText.manualEvidence}
                    </span>
                    <h2>插件人工补审</h2>
                    <p>用于自动提取失败、页面结构异常或需要补充人工证据的单条笔记。</p>
                  </div>
                  <GovernanceStatus value="NEEDS_REVIEW" domain="audit" />
                </div>
                <Alert
                  type="warning"
                  showIcon
                  message="备用提取方式"
                  description="打开单条笔记后使用浏览器插件重新提取。插件仍使用同一提取数据结构和审核规则。"
                />
              </Card>
            ),
          },
        ]}
      />}

      <Card
        bordered={false}
        className={`${styles.consoleCard} ${styles.progressCard}`}
      >
        <div className={styles.panelHeader}>
          <div>
            <span className={styles.eyebrow}>
              {businessUiText.auditOperations}
            </span>
            <h2>自动审核进度</h2>
            <p>实时观察队列执行、失败隔离和人工复核负载。</p>
          </div>
          {selectedBatch ? (
            <Tag color="blue">
              当前批次 · {selectedBatch.name || "未命名批次"}
            </Tag>
          ) : null}
        </div>
        {selectedBatch ? (
          <>
            <div className={styles.statsGrid}>
              {[
                {
                  label: "全部",
                  name: "总链接数",
                  value: selectedBatch.stats.total,
                  tone: "slate",
                  icon: <DatabaseOutlined />,
                },
                {
                  label: "等待中",
                  name: "等待数量",
                  value: selectedBatch.stats.waiting,
                  tone: "neutral",
                  icon: <ClockCircleOutlined />,
                },
                {
                  label: "处理中",
                  name: "处理中",
                  value: selectedBatch.stats.processing,
                  tone: "blue",
                  icon: <SyncOutlined spin={selectedBatch.stats.processing > 0} />,
                },
                {
                  label: "成功",
                  name: "成功数量",
                  value: selectedBatch.stats.succeeded,
                  tone: "green",
                  icon: <CheckCircleOutlined />,
                },
                {
                  label: "处理失败",
                  name: "失败数量",
                  value: selectedBatch.stats.failed,
                  tone: "red",
                  icon: <CloseCircleOutlined />,
                },
                {
                  label: "待人工复核",
                  name: "人工复核",
                  value: selectedBatch.stats.needsReview,
                  tone: "amber",
                  icon: <UserSwitchOutlined />,
                },
              ].map((item) => (
                <div
                  key={item.label}
                  className={`${styles.statCard} ${styles[item.tone]}`}
                >
                  <span className={styles.statIcon}>{item.icon}</span>
                  <div>
                    <span className={styles.statCode}>{item.label}</span>
                    <strong>{item.value}</strong>
                    <small>{item.name}</small>
                  </div>
                </div>
              ))}
            </div>

            <div className={styles.batchOverview}>
              <div className={styles.batchHeading}>
                <div>
                  <Space wrap size={10}>
                    <strong>{selectedBatch.name || "自动审核批次"}</strong>
                    <GovernanceStatus
                      value={selectedBatch.status}
                      domain="process"
                    />
                  </Space>
                  <p>
                    当前正在审核：
                    <span>{selectedBatch.currentTask?.url || "无"}</span>
                  </p>
                </div>
                <span className={styles.remainingCount}>
                  {businessUiText.remaining}
                  <strong>{selectedBatch.stats.remaining}</strong>
                </span>
              </div>
              <Progress
                percent={selectedBatch.stats.progress}
                strokeColor="#2563eb"
                trailColor="#e8edf4"
                status={
                  selectedBatch.status === "CANCELLED" ? "exception" : "active"
                }
              />
              {selectedBatch.lastErrorMessage ? (
                <Alert
                  className={styles.batchAlert}
                  type={
                    selectedBatch.status === "LOGIN_EXPIRED"
                      ? "warning"
                      : "error"
                  }
                  showIcon
                  message={selectedBatch.lastErrorMessage}
                  description="请根据上方提示处理后重试。"
                />
              ) : null}
              <Space wrap className={styles.batchActions}>
                <Button
                  icon={<PauseCircleOutlined />}
                  disabled={
                    !canOperate ||
                    !["QUEUED", "RUNNING"].includes(selectedBatch.status)
                  }
                  onClick={() => void controlBatch("PAUSE")}
                >
                  暂停
                </Button>
                <Button
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  disabled={
                    !canOperate ||
                    !["PAUSED", "LOGIN_EXPIRED"].includes(selectedBatch.status)
                  }
                  onClick={() => void controlBatch("CONTINUE")}
                >
                  继续
                </Button>
                <Button
                  danger
                  icon={<StopOutlined />}
                  disabled={[
                    "COMPLETED",
                    "COMPLETED_WITH_ERRORS",
                    "CANCELLED",
                  ].includes(selectedBatch.status) || !canOperate}
                  onClick={() => void controlBatch("CANCEL")}
                >
                  取消
                </Button>
                <Button
                  icon={<RetweetOutlined />}
                  disabled={
                    !canOperate ||
                    selectedBatch.stats.failed +
                      selectedBatch.stats.loginExpired ===
                    0
                  }
                  onClick={() => void controlBatch("RETRY_FAILED")}
                >
                  失败重试
                </Button>
              </Space>
            </div>

            <div className={styles.tableSectionHeader}>
              <div>
                <span className={styles.eyebrow}>
                  {businessUiText.executionLog}
                </span>
                <h3>审核执行记录</h3>
              </div>
              <span>
                {tasks.length} {businessUiText.records}
              </span>
            </div>
            <Table<Task>
              className={styles.enterpriseTable}
              rowKey="id"
              size="small"
              dataSource={tasks}
              loading={loading}
              locale={{ emptyText: "本次任务暂无执行记录" }}
              sticky={{ offsetHeader: 64 }}
              scroll={{ x: 1180 }}
              columns={[
                {
                  title: "顺序",
                  dataIndex: "queueOrder",
                  width: 70,
                  render: (_value, _row, index) => (
                    <span className={styles.sequence}>
                      {String(index + 1).padStart(2, "0")}
                    </span>
                  ),
                },
                {
                  title: "笔记链接",
                  dataIndex: "url",
                  width: 360,
                  ellipsis: true,
                  render: (value: string, row: Task) => (
                    <div className={styles.noteCell}>
                      <a href={value} target="_blank" rel="noreferrer">
                        {value}
                      </a>
                      {row.finalUrl && row.finalUrl !== value ? (
                        <a
                          href={row.finalUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {pageLinkLabels.FINAL} · {row.finalUrl}
                        </a>
                      ) : null}
                      {row.pageType || row.pageTitle ? (
                        <span>
                          {[businessPageTypeLabel(row.pageType), row.pageTitle]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      ) : null}
                    </div>
                  ),
                },
                {
                  title: "处理状态",
                  dataIndex: "status",
                  width: 150,
                  render: (value: string) => (
                    <GovernanceStatus value={value} domain="process" />
                  ),
                },
                {
                  title: "异常分类",
                  width: 270,
                  render: (_value, row) =>
                    row.failureMessage ? (
                      <span className={styles.errorText}>
                        {businessFailureReasonLabel(row.failureMessage)}
                      </span>
                    ) : (
                      <span className={styles.secondaryText}>
                        {businessUiText.noIssue}
                      </span>
                    ),
                },
                {
                  title: "尝试",
                  dataIndex: "attempts",
                  width: 80,
                  align: "center",
                },
                {
                  title: "审核结果",
                  width: 240,
                  render: (_value, row) => {
                    const result = row.auditResults[0];
                    return result ? (
                      <div className={styles.resultPills}>
                        <GovernanceStatus
                          value={result.autoStatus}
                          domain="audit"
                        />
                        {result.bodyCompliant ? (
                          <EvidencePill label={businessUiText.contentOk} />
                        ) : null}
                        {result.topicsCompliant &&
                        result.clickableCompliant ? (
                          <EvidencePill label={businessUiText.ruleMatch} />
                        ) : null}
                      </div>
                    ) : (
                      <span className={styles.secondaryText}>
                        {businessUiText.pendingConclusion}
                      </span>
                    );
                  },
                },
                {
                  title: "操作",
                  width: 120,
                  fixed: "right",
                  render: (_value, row) => {
                    const result = row.auditResults[0];
                    return (
                      <Button
                        type="text"
                        icon={<AuditOutlined />}
                        href={result ? `/results/${result.id}` : row.url}
                        target={result ? undefined : "_blank"}
                        className={styles.tableAction}
                      >
                        {result
                          ? canOperate &&
                            ["FAILED", "READ_FAILED", "LOGIN_EXPIRED"].includes(
                              row.status,
                            )
                            ? "人工补审"
                            : "查看结果"
                          : "查看笔记"}
                      </Button>
                    );
                  },
                },
              ]}
              pagination={{ pageSize: 8 }}
            />
          </>
        ) : (
          <Result
            status="info"
            title="暂无自动审核批次"
            subTitle="粘贴链接或导入 Excel 后，系统会自动开始逐条审核"
          />
        )}
      </Card>

      <Card bordered={false} className={styles.consoleCard}>
        <div className={styles.panelHeader}>
          <div>
            <span className={styles.eyebrow}>
              {businessUiText.recentActivity}
            </span>
            <h2>本次任务内容</h2>
            <p>查看本次审核任务中的全部笔记及最新执行状态。</p>
          </div>
          <FileSearchOutlined className={styles.headerIcon} />
        </div>
        {selectedBatch ? (
          <Descriptions
            className={styles.currentTaskSummary}
            size="small"
            bordered
            column={{ xs: 1, md: 2, xl: 4 }}
          >
            <Descriptions.Item label="批次名称">
              {selectedBatch.name || "未命名批次"}
            </Descriptions.Item>
            <Descriptions.Item label="所属产品">
              {selectedBatch.product?.name || "-"}
            </Descriptions.Item>
            <Descriptions.Item label="所属活动">
              {selectedBatch.campaign?.name || "-"}
            </Descriptions.Item>
            <Descriptions.Item label="产品阶段话题">
              {productStageTopicLabel(selectedBatch.productStage)}
            </Descriptions.Item>
            <Descriptions.Item label="任务来源">
              {businessSourceLabel(selectedBatch.source)}
            </Descriptions.Item>
            <Descriptions.Item label="本次笔记数">
              {tasks.length} 条
            </Descriptions.Item>
            <Descriptions.Item label="审核通过">
              {currentTaskSummary.passed} 条
            </Descriptions.Item>
            <Descriptions.Item label="审核不通过">
              {currentTaskSummary.failed} 条
            </Descriptions.Item>
            <Descriptions.Item label="待人工复核">
              {currentTaskSummary.needsReview} 条
            </Descriptions.Item>
            <Descriptions.Item label="任务状态">
              {businessStatusLabel(selectedBatch.status, "process")}
            </Descriptions.Item>
            <Descriptions.Item label="创建时间">
              {formatDateTime(selectedBatch.createdAt)}
            </Descriptions.Item>
            <Descriptions.Item label="完成时间">
              {formatDateTime(selectedBatch.finishedAt)}
            </Descriptions.Item>
          </Descriptions>
        ) : null}
        <Table<Task>
          className={styles.enterpriseTable}
          rowKey="id"
          loading={loading}
          dataSource={tasks}
          locale={{ emptyText: "本次任务暂无笔记" }}
          sticky={{ offsetHeader: 64 }}
          scroll={{ x: 980 }}
          columns={[
            {
              title: "笔记链接",
              dataIndex: "url",
              width: 360,
              ellipsis: true,
              render: (value: string, row: Task) => (
                <div className={styles.noteCell}>
                  <a href={value} target="_blank" rel="noreferrer">
                    {value}
                  </a>
                  {row.finalUrl && row.finalUrl !== value ? (
                    <span>{pageLinkLabels.FINAL} · {row.finalUrl}</span>
                  ) : null}
                </div>
              ),
            },
            {
              title: "产品",
              width: 170,
              render: (_value, row) => row.product.name,
            },
            {
              title: "活动",
              width: 260,
              render: (_value, row) => row.campaign.name,
            },
            {
              title: "产品阶段话题",
              dataIndex: "productStage",
              width: 150,
              render: (value: string | null) => productStageTopicLabel(value),
            },
            {
              title: "来源",
              dataIndex: "source",
              width: 100,
              render: (value: string) => (
                <span className={styles.sourceCode}>
                  {businessSourceLabel(value)}
                </span>
              ),
            },
            {
              title: "状态",
              dataIndex: "status",
              width: 150,
              render: (value: string) => (
                <GovernanceStatus value={value} domain="process" />
              ),
            },
            {
              title: "操作",
              width: 120,
              fixed: "right",
              render: (_value, row) => {
                const result = row.auditResults[0];
                return (
                  <Button
                    type="text"
                    icon={<AuditOutlined />}
                    href={result ? `/results/${result.id}` : row.url}
                    target={result ? undefined : "_blank"}
                    className={styles.tableAction}
                  >
                    {result
                      ? canOperate &&
                        ["FAILED", "READ_FAILED", "LOGIN_EXPIRED"].includes(
                          row.status,
                        )
                        ? "人工补审"
                        : "查看结果"
                      : "查看笔记"}
                  </Button>
                );
              },
            },
          ]}
          pagination={{ pageSize: 8 }}
        />
      </Card>
    </div>
  );
}
