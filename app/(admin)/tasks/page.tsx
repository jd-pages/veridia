"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Modal,
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
  DeleteOutlined,
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
  type ImportTemplateBrand,
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
import {
  taskExecutionFilterLabels,
  type TaskExecutionFilter,
} from "@/lib/automation/task-execution-filter";
import { canClearAutomaticBatch } from "@/lib/automation/task-view";

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
  product?: Product | null;
  products?: Array<{ product: Product }>;
  requiresProductStage: boolean;
  stageOptions?: Array<{ value: string; label: string }>;
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
  batch: { id: string; name: string | null } | null;
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
  importRecordId: string | null;
  importRecord: {
    id: string;
    fileName: string;
    createdAt: string;
  } | null;
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
  sessionState?: string;
  controlState?:
    | "NOT_STARTED"
    | "CONNECTING"
    | "READY"
    | "DISCONNECTED"
    | "RESTART_REQUIRED";
  controlReady?: boolean;
  controlLastError?: string | null;
  lastLoginAt: string | null;
  lastError: string | null;
}

interface ImportPreview {
  total: number;
  validCount: number;
  invalidCount: number;
  imported: number;
  batchId?: string | null;
  auditBatchId?: string | null;
  importRecordId?: string | null;
  fileName?: string;
  importedAt?: string | null;
  importedCount?: number;
  rowsTruncated?: boolean;
  errorRowsTruncated?: boolean;
  templateVersion: string;
  templateBrand: "达能" | "佳贝艾特";
  templateType: "DANONE_CUSTOMER" | "DANONE_AGENCY" | "KABRITA";
  sourceLabel: string;
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
    purchaseProductLine: string;
    campaignName: string;
    importedCampaignName: string;
    campaignMatchStatus: string;
    campaignPeriod: string;
    campaignRuleCount: number;
    month: string;
    productStage: string;
    stageGroup: string;
    errors: string[];
  }>;
  errorRows: Array<ImportPreview["rows"][number]>;
}

const activeBatchStatuses = new Set([
  "QUEUED",
  "RUNNING",
  "PAUSED",
  "LOGIN_EXPIRED",
  "SECURITY_RESTRICTED",
]);

const emptyBatchStats: BatchStats = {
  total: 0,
  waiting: 0,
  processing: 0,
  succeeded: 0,
  failed: 0,
  readFailed: 0,
  loginExpired: 0,
  needsReview: 0,
  cancelled: 0,
  completed: 0,
  remaining: 0,
  progress: 0,
};

const ALL_CURRENT_BATCHES = "__ALL_CURRENT_BATCHES__";

interface TaskPage {
  items: Task[];
  total: number;
  page: number;
  pageSize: number;
}

interface ClearBatchResponse {
  clearedBatchId: string;
  clearedTaskCount: number;
  retainedAuditResultCount: number;
  nextBatchId: string | null;
  clearedAt: string;
  alreadyCleared: boolean;
}

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
  SECURITY_RESTRICTED: "warning",
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

function rememberCurrentBatches(batchIds: string[]) {
  const url = new URL(window.location.href);
  url.searchParams.delete("batchId");
  url.searchParams.delete("batchIds");
  if (batchIds.length === 1) url.searchParams.set("batchId", batchIds[0]);
  else if (batchIds.length > 1) {
    url.searchParams.set("batchIds", batchIds.join(","));
  }
  window.history.replaceState(window.history.state, "", url);
}

export default function TasksPage() {
  const { message } = App.useApp();
  const [products, setProducts] = useState<Product[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskTotal, setTaskTotal] = useState(0);
  const [taskPage, setTaskPage] = useState(1);
  const [taskPageSize, setTaskPageSize] = useState(50);
  const [batches, setBatches] = useState<AuditBatch[]>([]);
  const [trackedBatchIds, setTrackedBatchIds] = useState<string[]>([]);
  const [session, setSession] = useState<AutomationSession | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState(
    ALL_CURRENT_BATCHES,
  );
  const [taskExecutionFilter, setTaskExecutionFilter] =
    useState<TaskExecutionFilter>("ALL");
  const loadSequence = useRef(0);
  const clearedBatchIds = useRef(new Set<string>());
  const [batchPendingClear, setBatchPendingClear] =
    useState<AuditBatch | null>(null);
  const [clearingBatchId, setClearingBatchId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const selectedProduct = Form.useWatch("productId", form);
  const selectedCampaign = Form.useWatch("campaignId", form);
  const selectedStage = Form.useWatch("productStage", form);
  const selectedCampaignDefinition = useMemo(
    () => campaigns.find((campaign) => campaign.id === selectedCampaign),
    [campaigns, selectedCampaign],
  );
  const selectedCampaignRequiresStage = Boolean(
    selectedCampaignDefinition?.requiresProductStage,
  );
  const availableProducts = useMemo(() => {
    if (!selectedCampaignDefinition) return [];
    const productIds = new Set([
      selectedCampaignDefinition.productId,
      selectedCampaignDefinition.product?.id,
      ...(selectedCampaignDefinition.products || []).map(
        ({ product }) => product.id,
      ),
    ].filter((value): value is string => Boolean(value)));
    return products.filter((product) => productIds.has(product.id));
  }, [products, selectedCampaignDefinition]);
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
  const [previewView, setPreviewView] = useState<"ERRORS" | "ALL">("ERRORS");
  const [previewPage, setPreviewPage] = useState(1);
  const [importing, setImporting] = useState(false);
  const [templateDownloading, setTemplateDownloading] = useState(false);
  const [currentRole, setCurrentRole] = useState<SessionUser["role"] | null>(
    null,
  );
  const canOperate = canAccessBusiness(currentRole);

  const load = useCallback(
    async (
      quiet = false,
      requestedBatchIds: string[] = [],
      requestedPage = 1,
      requestedPageSize = 50,
      requestedSelection = ALL_CURRENT_BATCHES,
      requestedExecutionFilter: TaskExecutionFilter = "ALL",
    ) => {
      const requestSequence = ++loadSequence.current;
      if (!quiet) setLoading(true);
      const batchQuery = new URLSearchParams({
        includeTasks: "false",
        limit: "50",
      });
      if (requestedBatchIds.length) {
        batchQuery.set("batchIds", requestedBatchIds.join(","));
      }
      const [batchResult, sessionResult] = await Promise.allSettled([
        apiFetch<AuditBatch[]>(`/api/automation/batches?${batchQuery}`, {
          cache: "no-store",
        }),
        apiFetch<AutomationSession>("/api/automation/session"),
      ]);
      if (requestSequence !== loadSequence.current) return;
      let dataFailure: PromiseRejectedResult | undefined;
      if (!quiet) {
        const [productResult, campaignResult] = await Promise.allSettled([
          apiFetch<Product[]>("/api/products"),
          apiFetch<Campaign[]>("/api/campaigns"),
        ]);
        if (productResult.status === "fulfilled") {
          setProducts(productResult.value);
        }
        if (campaignResult.status === "fulfilled") {
          setCampaigns(campaignResult.value);
        }
        dataFailure = [productResult, campaignResult].find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
      }
      if (batchResult.status === "fulfilled") {
        const visibleBatches = batchResult.value.filter(
          (batch) => !clearedBatchIds.current.has(batch.id),
        );
        const activeBatches = visibleBatches.filter((batch) =>
          activeBatchStatuses.has(batch.status),
        );
        const queueBatches = requestedBatchIds.length
          ? visibleBatches
          : activeBatches.length
            ? activeBatches
            : visibleBatches.slice(0, 1);
        const resolvedBatchIds = queueBatches.map((batch) => batch.id);
        const effectiveSelection =
          requestedSelection !== ALL_CURRENT_BATCHES &&
          resolvedBatchIds.includes(requestedSelection)
            ? requestedSelection
            : ALL_CURRENT_BATCHES;
        setBatches(queueBatches);
        setTrackedBatchIds(resolvedBatchIds);
        setSelectedBatchId(effectiveSelection);
        rememberCurrentBatches(resolvedBatchIds);
        const taskBatchIds =
          effectiveSelection === ALL_CURRENT_BATCHES
            ? resolvedBatchIds
            : [effectiveSelection];
        if (taskBatchIds.length) {
          try {
            const query = new URLSearchParams({
              batchIds: taskBatchIds.join(","),
              page: String(requestedPage),
              pageSize: String(requestedPageSize),
              executionStatus: requestedExecutionFilter,
            });
            const currentTasks = await apiFetch<TaskPage>(`/api/tasks?${query}`, {
              cache: "no-store",
            });
            if (requestSequence !== loadSequence.current) return;
            setTasks((previous) =>
              JSON.stringify(previous) === JSON.stringify(currentTasks.items)
                ? previous
                : currentTasks.items,
            );
            setTaskTotal(currentTasks.total);
            setTaskPage(currentTasks.page);
            setTaskPageSize(currentTasks.pageSize);
          } catch (error) {
            setTasks([]);
            setTaskTotal(0);
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
          setTaskTotal(0);
        }
      } else {
        dataFailure = batchResult;
      }
      if (sessionResult.status === "fulfilled") {
        setSession(sessionResult.value);
      } else {
        setSession({
          status: "LOGIN_REQUIRED",
          lastLoginAt: null,
          lastError: null,
        });
      }
      if (!quiet && dataFailure) {
        message.error(
          dataFailure.reason instanceof Error
            ? dataFailure.reason.message
            : "数据读取失败，请刷新或重启 VERIDIA。",
        );
      }
      setLoading(false);
    },
    [message],
  );

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const requestedBatchId = search.get("batchId")?.trim() || "";
    const requestedBatchIds = (search.get("batchIds") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const initialBatchIds = requestedBatchIds.length
      ? requestedBatchIds
      : requestedBatchId
        ? [requestedBatchId]
        : [];
    void load(
      false,
      initialBatchIds,
      1,
      50,
      requestedBatchId || ALL_CURRENT_BATCHES,
      "ALL",
    );
    void apiFetch<SessionUser | null>("/api/auth/me").then((user) =>
      setCurrentRole(user?.role || null),
    );
  }, [load]);

  useEffect(() => {
    if (
      !selectedProduct ||
      !selectedCampaign ||
      (selectedCampaignRequiresStage && !selectedStage)
    ) {
      setRequirements(null);
      return;
    }
    let cancelled = false;
    const stageQuery = selectedCampaignRequiresStage && selectedStage
      ? `&stage=${encodeURIComponent(selectedStage)}`
      : "";
    apiFetch<AuditRequirements>(
      `/api/campaigns/${selectedCampaign}/requirements?productId=${encodeURIComponent(selectedProduct)}${stageQuery}`,
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
  }, [
    message,
    selectedCampaign,
    selectedCampaignRequiresStage,
    selectedProduct,
    selectedStage,
  ]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (
        !clearingBatchId &&
        batches.some((batch) => activeBatchStatuses.has(batch.status))
      ) {
        void load(
          true,
          trackedBatchIds,
          taskPage,
          taskPageSize,
          selectedBatchId,
          taskExecutionFilter,
        );
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [
    batches,
    clearingBatchId,
    load,
    selectedBatchId,
    taskPage,
    taskPageSize,
    taskExecutionFilter,
    trackedBatchIds,
  ]);

  const selectedBatch = useMemo(() => {
    const focused = batches.find((batch) => batch.id === selectedBatchId);
    if (focused || batches.length <= 1) return focused || batches[0];
    const sum = (field: keyof BatchStats) =>
      batches.reduce((total, batch) => total + batch.stats[field], 0);
    const total = sum("total");
    const completed = sum("completed");
    const status =
      batches.find((batch) => batch.status === "RUNNING")?.status ||
      batches.find((batch) => batch.status === "QUEUED")?.status ||
      batches.find((batch) => batch.status === "PAUSED")?.status ||
      batches.find((batch) => batch.status === "LOGIN_EXPIRED")?.status ||
      batches.find((batch) => batch.status === "SECURITY_RESTRICTED")?.status ||
      (batches.some((batch) => batch.status === "COMPLETED_WITH_ERRORS")
        ? "COMPLETED_WITH_ERRORS"
        : "COMPLETED");
    return {
      ...batches[0],
      id: ALL_CURRENT_BATCHES,
      name: `当前队列：${batches.length} 个批次`,
      status,
      source: "QUEUE",
      productStage: null,
      product: null,
      campaign: null,
      finishedAt: batches.every((batch) => batch.finishedAt)
        ? batches[0].finishedAt
        : null,
      stats: {
        total,
        waiting: sum("waiting"),
        processing: sum("processing"),
        succeeded: sum("succeeded"),
        failed: sum("failed"),
        readFailed: sum("readFailed"),
        loginExpired: sum("loginExpired"),
        needsReview: sum("needsReview"),
        cancelled: sum("cancelled"),
        completed,
        remaining: sum("remaining"),
        progress: total > 0 ? Math.round((completed / total) * 100) : 0,
      },
      currentTask:
        batches.find((batch) => batch.currentTask)?.currentTask || null,
      lastErrorCode:
        batches.find((batch) => batch.lastErrorCode)?.lastErrorCode || null,
      lastErrorMessage:
        batches.find((batch) => batch.lastErrorMessage)?.lastErrorMessage || null,
    } satisfies AuditBatch;
  }, [batches, selectedBatchId]);
  const isCombinedQueue = selectedBatch?.id === ALL_CURRENT_BATCHES;
  const displayBatchStats = selectedBatch?.stats || emptyBatchStats;
  const taskExecutionEmptyText =
    taskExecutionFilter === "ALL"
      ? "当前批次暂无执行记录"
      : `当前批次暂无${taskExecutionFilterLabels[taskExecutionFilter]}记录`;
  const applyTaskExecutionFilter = (filter: TaskExecutionFilter) => {
    setTaskExecutionFilter(filter);
    setTaskPage(1);
    void load(
      true,
      trackedBatchIds,
      1,
      taskPageSize,
      selectedBatchId,
      filter,
    );
  };
  const currentTaskSummary = useMemo(
    () => ({
      passed: selectedBatch?.stats.succeeded || 0,
      failed: selectedBatch?.stats.failed || 0,
      needsReview: selectedBatch?.stats.needsReview || 0,
    }),
    [selectedBatch],
  );
  const requiredStageTopics = useMemo(
    () => requirements && selectedCampaignRequiresStage
      ? stageTopicsForProductStage(
          requirements.context.rules,
          requirements.context.productStage,
        )
      : [],
    [requirements, selectedCampaignRequiresStage],
  );

  const createBatch = async (values: {
    name?: string;
    productId: string;
    campaignId: string;
    productStage?: string;
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
      const nextBatchIds = [...new Set([...trackedBatchIds, result.batchId])];
      setTrackedBatchIds(nextBatchIds);
      setSelectedBatchId(ALL_CURRENT_BATCHES);
      setTaskPage(1);
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
      await load(
        true,
        nextBatchIds,
        1,
        taskPageSize,
        ALL_CURRENT_BATCHES,
        taskExecutionFilter,
      );
    } catch (error) {
      message.error(error instanceof Error ? error.message : "创建批次失败");
    } finally {
      setSubmitting(false);
    }
  };

  const submitExcel = async (commit: boolean) => {
    const file = fileList[0]?.originFileObj;
    if (!file) {
      message.warning("请先选择 Excel（.xlsx）表格");
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
      setPreviewView("ERRORS");
      setPreviewPage(1);
      if (commit) {
        const nextBatchIds = result.batchId
          ? [...new Set([...trackedBatchIds, result.batchId])]
          : trackedBatchIds;
        setTrackedBatchIds(nextBatchIds);
        setSelectedBatchId(ALL_CURRENT_BATCHES);
        setTaskPage(1);
        message.success(`已导入 ${result.imported} 条，自动审核已开始`);
        await load(
          true,
          nextBatchIds,
          1,
          taskPageSize,
          ALL_CURRENT_BATCHES,
          taskExecutionFilter,
        );
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
    if (!selectedBatch || isCombinedQueue) return;
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
      await load(
        true,
        trackedBatchIds,
        taskPage,
        taskPageSize,
        selectedBatch.id,
        taskExecutionFilter,
      );
    } catch (error) {
      message.error(error instanceof Error ? error.message : "队列操作失败");
    }
  };

  const requestClearSelectedBatch = () => {
    if (!selectedBatch || isCombinedQueue || clearingBatchId) return;
    if (!canClearAutomaticBatch({
      status: selectedBatch.status,
      processingTaskCount: selectedBatch.stats.processing,
      currentTaskId: selectedBatch.currentTask?.id,
    })) {
      message.warning("当前批次仍在运行，请先暂停或取消任务后再清除。");
      return;
    }
    setBatchPendingClear(selectedBatch);
  };

  const confirmClearSelectedBatch = async () => {
    const target = batchPendingClear;
    if (!target || clearingBatchId) return;
    loadSequence.current += 1;
    setClearingBatchId(target.id);
    try {
      const result = await apiFetch<ClearBatchResponse>(
        `/api/automation/batches/${target.id}/clear`,
        { method: "POST" },
      );
      clearedBatchIds.current.add(result.clearedBatchId);
      loadSequence.current += 1;
      const nextBatchIds = result.nextBatchId ? [result.nextBatchId] : [];
      setBatches([]);
      setTrackedBatchIds([]);
      setSelectedBatchId(ALL_CURRENT_BATCHES);
      setTaskExecutionFilter("ALL");
      setTaskPage(1);
      setTasks([]);
      setTaskTotal(0);
      rememberCurrentBatches([]);
      setBatchPendingClear(null);
      await load(
        true,
        nextBatchIds,
        1,
        taskPageSize,
        result.nextBatchId || ALL_CURRENT_BATCHES,
        "ALL",
      );
      message.success(
        `已清除当前批次，保留 ${result.retainedAuditResultCount} 条正式审核结果。`,
      );
    } catch (error) {
      message.error(error instanceof Error ? error.message : "清除当前批次失败");
      throw error;
    } finally {
      setClearingBatchId(null);
    }
  };

  const loginAction = async (
    action:
      | "START_LOGIN"
      | "COMPLETE_LOGIN"
      | "CHECK_SESSION"
      | "RESTART_BROWSER",
  ) => {
    try {
      const result = await apiFetch<AutomationSession>("/api/automation/session", {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      setSession(result);
      if (action === "START_LOGIN") {
        message.info("专用浏览器已打开，请手动登录或扫码");
      } else if (action === "RESTART_BROWSER" && result.controlReady) {
        message.success("专用浏览器控制连接已重新建立");
      } else if (result.sessionState === "LOGGED_IN" || result.status === "READY") {
        message.success("登录状态已保存，可以继续自动审核");
      } else if (result.sessionState === "NETWORK_ERROR") {
        message.warning("登录检测遇到网络异常，当前状态未判定为退出登录");
      } else {
        message.warning(result.lastError || "尚未识别到有效登录状态");
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "登录操作失败");
    }
  };

  const downloadTemplate = async (
    format: ImportTemplateFormat,
    brand: ImportTemplateBrand,
  ) => {
    if (templateDownloading) return;
    setTemplateDownloading(true);
    try {
      const result = await downloadImportTemplate(format, brand);
      if (result.saved) message.success(`导入模板已保存：${result.fileName}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "下载导入模板失败");
    } finally {
      setTemplateDownloading(false);
    }
  };

  const browserControlBlocked = Boolean(
    session?.status === "READY" &&
      ["DISCONNECTED", "RESTART_REQUIRED"].includes(
        session.controlState || "",
      ),
  );

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
            <Button
              icon={<ReloadOutlined />}
              onClick={() =>
                void load(
                  false,
                  trackedBatchIds,
                  taskPage,
                  taskPageSize,
                  selectedBatchId,
                  taskExecutionFilter,
                )
              }
            >
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
              <Tag color={session?.controlReady ? "green" : "orange"}>
                控制连接：
                {session?.controlReady
                  ? "正常"
                  : session?.controlState === "CONNECTING"
                    ? "正在连接"
                    : "需要重新启动"}
              </Tag>
            </div>
            <p>
              {session?.lastLoginAt
                ? `最近登录 ${new Date(session.lastLoginAt).toLocaleString("zh-CN")}`
                : "尚未保存可复用的登录状态"}
            </p>
            {session?.lastError ? (
              <span className={styles.inlineError}>{session.lastError}</span>
            ) : null}
            {session?.controlLastError ? (
              <span className={styles.inlineError}>
                {session.controlLastError}
              </span>
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
            我已完成登录/验证
          </Button>
          <Button onClick={() => void loginAction("CHECK_SESSION")}>
            重新检测
          </Button>
          <Button onClick={() => void loginAction("RESTART_BROWSER")}>
            重新启动专用浏览器
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
                            name="campaignId"
                            label="所属活动"
                            rules={[{ required: true }]}
                          >
                            <Select
                              showSearch
                              optionFilterProp="label"
                              placeholder="请选择活动"
                              onChange={() => {
                                form.resetFields(["productId", "productStage"]);
                                setRequirements(null);
                              }}
                              options={campaigns.map((item) => ({
                                value: item.id,
                                label: `${item.month} · ${item.name}`,
                              }))}
                            />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={12}>
                          <Form.Item
                            name="productId"
                            label="所属产品"
                            rules={[{ required: true }]}
                          >
                            <Select
                              showSearch
                              optionFilterProp="label"
                              disabled={!selectedCampaign}
                              placeholder={
                                selectedCampaign
                                  ? "请选择产品"
                                  : "请先选择活动"
                              }
                              options={availableProducts.map((item) => ({
                                value: item.id,
                                label: item.code
                                  ? `${item.code} · ${item.name}`
                                  : item.name,
                              }))}
                              onChange={() => {
                                form.resetFields(["productStage"]);
                                setRequirements(null);
                              }}
                            />
                          </Form.Item>
                        </Col>
                      </Row>
                      {selectedCampaignRequiresStage ? (
                        <Form.Item
                          name="productStage"
                          label="产品阶段话题"
                          rules={[{ required: true }]}
                          extra={
                            selectedCampaignDefinition?.stageOptions?.some(
                              (item) => item.value.includes("_"),
                            )
                              ? "请选择与具体段位对应的阶段组。"
                              : "请选择 IFFO 或 GUM。"
                          }
                        >
                          <Select
                            placeholder="选择产品阶段话题"
                            options={
                              selectedCampaignDefinition?.stageOptions?.length
                                ? selectedCampaignDefinition.stageOptions
                                : PRODUCT_STAGE_TOPIC_OPTIONS.map((item) => ({
                                    value: item.value,
                                    label: item.label,
                                  }))
                            }
                          />
                        </Form.Item>
                      ) : null}
                      {requirements ? (
                        <Alert
                          showIcon
                          type="info"
                          className={styles.requirementsAlert}
                          message={`当前规则集 · ${requirements.product.name}${
                            selectedCampaignRequiresStage
                              ? ` · ${productStageTopicLabel(requirements.context.productStage)}`
                              : ""
                          }`}
                          description={
                            <Space direction="vertical" size={5}>
                              <span>
                                图文笔记至少 {requirements.context.minImageCount} 张图片；
                                有效正文至少 {requirements.context.minBodyLength} 字；
                                {requirements.context.publicRequired
                                  ? `公开并保留 ${requirements.context.retentionDays} 天`
                                  : "不要求公开"}
                              </span>
                              {selectedCampaignRequiresStage ? (
                                <span>
                                  要求阶段话题：
                                  {requiredStageTopics.join(" / ")}
                                </span>
                              ) : null}
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
                        disabled={browserControlBlocked}
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
                      支持 Excel（.xlsx）；请按业务类型下载对应模板。
                    </p>
                  </div>
                  <Dropdown
                    menu={{
                      items: [
                        {
                          key: "danone-customer-xlsx",
                          label: "下载达能客户 Excel 模板",
                          onClick: () => void downloadTemplate("xlsx", "danone-customer"),
                        },
                        {
                          key: "danone-agency-xlsx",
                          label: "下载达能代发 Excel 模板",
                          onClick: () => void downloadTemplate("xlsx", "danone-agency"),
                        },
                        { type: "divider" },
                        {
                          key: "kabrita-xlsx",
                          label: "下载佳贝艾特 Excel 模板",
                          onClick: () =>
                            void downloadTemplate("xlsx", "kabrita"),
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
                    accept=".xlsx"
                    maxCount={1}
                    fileList={fileList}
                    beforeUpload={(file) => {
                      if (!file.name.toLocaleLowerCase().endsWith(".xlsx")) {
                        message.error(
                          "暂不支持CSV文件，请下载最新版Excel导入模板后重新填写。",
                        );
                        return Upload.LIST_IGNORE;
                      }
                      return false;
                    }}
                    onChange={({ fileList: next }) => {
                      setFileList(next.slice(-1));
                      setPreview(null);
                      setPreviewView("ERRORS");
                      setPreviewPage(1);
                    }}
                  >
                    <p className="ant-upload-drag-icon">
                      <InboxOutlined />
                    </p>
                    <p className="ant-upload-text">
                      点击或拖入 Excel 表格
                    </p>
                    <p className="ant-upload-hint">
                      支持 Excel（.xlsx）
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
                      disabled={
                        !preview ||
                        preview.validCount === 0 ||
                        browserControlBlocked
                      }
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
                        <Descriptions.Item label="模板品牌">
                          {preview.templateBrand}
                        </Descriptions.Item>
                        <Descriptions.Item label="模板类型">
                          {preview.templateType === "DANONE_AGENCY"
                            ? "达能代发"
                            : preview.templateType === "DANONE_CUSTOMER"
                              ? "达能客户"
                              : "佳贝艾特"}
                        </Descriptions.Item>
                        <Descriptions.Item label="数据源类型">
                          {preview.sourceLabel || preview.sourceType}
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
                        <Descriptions.Item label="数据行">
                          {preview.total} 条
                        </Descriptions.Item>
                      </Descriptions>
                      {preview.rowsTruncated ? (
                        <Alert
                          type="info"
                          showIcon
                          message={`预检结果共 ${preview.total} 条，页面仅展示前 ${preview.rows.length} 条；全部有效数据仍会正常入队。`}
                        />
                      ) : null}
                      <Space wrap>
                        <Alert
                          type={preview.invalidCount ? "warning" : "success"}
                          showIcon
                          message={
                            preview.invalidCount
                              ? previewView === "ERRORS"
                                ? `当前仅显示异常记录，共 ${preview.invalidCount} 条。`
                                : `当前显示全部预检记录，共 ${preview.total} 条。`
                              : previewView === "ERRORS"
                                ? "预检查通过，无异常记录"
                                : `当前显示全部预检记录，共 ${preview.total} 条。`
                          }
                        />
                        <Button
                          onClick={() => {
                            setPreviewView((current) =>
                              current === "ERRORS" ? "ALL" : "ERRORS",
                            );
                            setPreviewPage(1);
                          }}
                        >
                          {previewView === "ERRORS" ? "查看全部记录" : "仅看异常"}
                        </Button>
                      </Space>
                      {previewView === "ALL" || preview.errorRows.length ? (
                      <div className={styles.previewTableShell}>
                        <Table<ImportPreview["rows"][number]>
                          className={styles.enterpriseTable}
                          rowKey="rowNumber"
                          size="small"
                          dataSource={
                            previewView === "ERRORS"
                              ? preview.errorRows
                              : preview.rows
                          }
                          tableLayout="fixed"
                          scroll={{ x: 1500 }}
                        columns={[
                          { title: "行", dataIndex: "rowNumber", width: 70 },
                          {
                            title:
                              preview.templateBrand === "佳贝艾特"
                                ? "小红书发布链接"
                                : "原始链接内容",
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
                          ...(preview.templateBrand === "佳贝艾特"
                            ? [
                                {
                                  title: "购买产品线",
                                  dataIndex: "purchaseProductLine",
                                  width: 160,
                                  render: (value: string) => (
                                    <span
                                      className={styles.previewEllipsis}
                                      title={value}
                                    >
                                      {value || "-"}
                                    </span>
                                  ),
                                },
                              ]
                            : []),
                          {
                            title: "活动名称",
                            dataIndex: "campaignName",
                            width: 260,
                            render: (value: string, row) => (
                              <div className={styles.previewWrap}>
                                <div title={value || row.importedCampaignName}>
                                  {value || row.importedCampaignName || "-"}
                                </div>
                                <Tag color={row.campaignMatchStatus === "MATCHED" ? "green" : "red"}>
                                  {row.campaignMatchStatus === "MATCHED" ? "已匹配" : "匹配异常"}
                                </Tag>
                              </div>
                            ),
                          },
                          {
                            title: "活动月份 / 周期",
                            width: 220,
                            render: (_value, row) => (
                              <span className={styles.previewWrap}>
                                {row.month || "-"}<br />{row.campaignPeriod || "-"}
                              </span>
                            ),
                          },
                          {
                            title: "关联规则",
                            dataIndex: "campaignRuleCount",
                            width: 110,
                            render: (value: number) => `${value || 0} 条`,
                          },
                          ...(preview.templateBrand === "佳贝艾特"
                            ? []
                            : [
                                {
                                  title: (
                                    <span className={styles.previewHeaderWrap}>
                                      产品阶段话题
                                    </span>
                                  ),
                                  width: 130,
                                  align: "center" as const,
                                  render: (
                                    _value: unknown,
                                    row: ImportPreview["rows"][number],
                                  ) =>
                                    row.productStage ? (
                                      <span className={styles.stageTopicCell}>
                                        <Tag>
                                          {row.stageGroup ||
                                            productStageTopicLabel(
                                              row.productStage,
                                            )}
                                        </Tag>
                                      </span>
                                    ) : (
                                      "-"
                                    ),
                                },
                              ]),
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
                            current: previewPage,
                            pageSize: 50,
                            showSizeChanger: false,
                            position: ["bottomRight"],
                            onChange: setPreviewPage,
                          }}
                        />
                      </div>
                      ) : null}
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
        <div className={styles.statsGrid}>
              {[
                {
                  filter: "ALL" as const,
                  label: "全部",
                  name: "总链接数",
                  value: displayBatchStats.total,
                  tone: "slate",
                  icon: <DatabaseOutlined />,
                },
                {
                  filter: "WAITING" as const,
                  label: "等待中",
                  name: "等待数量",
                  value: displayBatchStats.waiting,
                  tone: "neutral",
                  icon: <ClockCircleOutlined />,
                },
                {
                  filter: "PROCESSING" as const,
                  label: "处理中",
                  name: "处理中",
                  value: displayBatchStats.processing,
                  tone: "blue",
                  icon: <SyncOutlined spin={displayBatchStats.processing > 0} />,
                },
                {
                  filter: "SUCCEEDED" as const,
                  label: "成功",
                  name: "成功数量",
                  value: displayBatchStats.succeeded,
                  tone: "green",
                  icon: <CheckCircleOutlined />,
                },
                {
                  filter: "FAILED" as const,
                  label: "处理失败",
                  name: "失败数量",
                  value: displayBatchStats.failed,
                  tone: "red",
                  icon: <CloseCircleOutlined />,
                },
                {
                  filter: "NEEDS_REVIEW" as const,
                  label: "待人工复核",
                  name: "人工复核",
                  value: displayBatchStats.needsReview,
                  tone: "amber",
                  icon: <UserSwitchOutlined />,
                },
              ].map((item) => (
                <button
                  type="button"
                  key={item.label}
                  aria-label={`筛选${item.label}记录`}
                  aria-pressed={taskExecutionFilter === item.filter}
                  disabled={!selectedBatch}
                  className={`${styles.statCard} ${styles[item.tone]} ${
                    taskExecutionFilter === item.filter
                      ? styles.statCardSelected
                      : ""
                  }`}
                  onClick={() => applyTaskExecutionFilter(item.filter)}
                >
                  <span className={styles.statIcon}>{item.icon}</span>
                  <div>
                    <span className={styles.statCode}>{item.label}</span>
                    <strong>{item.value}</strong>
                    <small>{item.name}</small>
                  </div>
                </button>
              ))}
        </div>
        {selectedBatch ? (
          <>
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
                <div className={styles.batchHeadingActions}>
                  <span className={styles.remainingCount}>
                    {businessUiText.remaining}
                    <strong>{selectedBatch.stats.remaining}</strong>
                  </span>
                  <Button
                    danger
                    icon={<DeleteOutlined />}
                    loading={clearingBatchId === selectedBatch.id}
                    disabled={!canOperate || isCombinedQueue}
                    title={
                      isCombinedQueue
                        ? "请先从批次下拉框选择一个批次"
                        : "清除当前选中的审核批次"
                    }
                    onClick={requestClearSelectedBatch}
                  >
                    清除当前批次
                  </Button>
                </div>
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
                    selectedBatch.lastErrorCode === "ACCESS_COOLDOWN"
                      ? "info"
                      : ["LOGIN_EXPIRED", "SECURITY_RESTRICTED"].includes(
                            selectedBatch.status,
                          )
                        ? "warning"
                        : "error"
                  }
                  showIcon
                  message={selectedBatch.lastErrorMessage}
                  description={
                    selectedBatch.lastErrorCode === "ACCESS_COOLDOWN"
                      ? "冷却期间仍可暂停或取消任务。"
                      : "请根据上方提示处理后重试。"
                  }
                />
              ) : null}
              <Space wrap className={styles.batchActions}>
                <Button
                  icon={<PauseCircleOutlined />}
                  disabled={
                    !canOperate ||
                    isCombinedQueue ||
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
                    isCombinedQueue ||
                    !["PAUSED", "LOGIN_EXPIRED", "SECURITY_RESTRICTED"].includes(
                      selectedBatch.status,
                    )
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
                  ].includes(selectedBatch.status) || !canOperate || isCombinedQueue}
                  onClick={() => void controlBatch("CANCEL")}
                >
                  取消
                </Button>
                <Button
                  icon={<RetweetOutlined />}
                  disabled={
                    !canOperate ||
                    isCombinedQueue ||
                    selectedBatch.stats.failed +
                      selectedBatch.stats.loginExpired ===
                    0
                  }
                  onClick={() => void controlBatch("RETRY_FAILED")}
                >
                  失败重试
                </Button>
                {!isCombinedQueue &&
                selectedBatch.importRecordId &&
                ["COMPLETED", "COMPLETED_WITH_ERRORS"].includes(
                  selectedBatch.status,
                ) ? (
                  <Button
                    icon={<FileSearchOutlined />}
                    href={`/results?importRecordId=${encodeURIComponent(selectedBatch.importRecordId)}`}
                  >
                    查看本批审核结果
                  </Button>
                ) : null}
              </Space>
            </div>

            <div className={styles.tableSectionHeader}>
              <div>
                <span className={styles.eyebrow}>
                  {businessUiText.executionLog}
                </span>
                <h3>审核执行记录</h3>
              </div>
              <Space wrap>
                <Select
                  aria-label="执行记录批次筛选"
                  value={selectedBatchId}
                  style={{ minWidth: 220 }}
                  options={[
                    {
                      value: ALL_CURRENT_BATCHES,
                      label: `全部当前批次（${batches.length}）`,
                    },
                    ...batches.map((batch) => ({
                      value: batch.id,
                      label: `${batch.name || "未命名批次"}（${batch.stats.total} 条）`,
                    })),
                  ]}
                  onChange={(value) => {
                    setSelectedBatchId(value);
                    setTaskPage(1);
                    void load(
                      true,
                      trackedBatchIds,
                      1,
                      taskPageSize,
                      value,
                      taskExecutionFilter,
                    );
                  }}
                />
                <span>
                  当前显示 {taskTotal} {businessUiText.records}
                </span>
              </Space>
            </div>
            <Table<Task>
              className={styles.enterpriseTable}
              rowKey="id"
              size="small"
              dataSource={tasks}
              loading={loading}
              locale={{ emptyText: taskExecutionEmptyText }}
              sticky={{ offsetHeader: 64 }}
              scroll={{ x: 1180 }}
              columns={[
                {
                  title: "顺序",
                  dataIndex: "queueOrder",
                  width: 70,
                  render: (_value, _row, index) => (
                    <span className={styles.sequence}>
                      {String((taskPage - 1) * taskPageSize + index + 1).padStart(
                        2,
                        "0",
                      )}
                    </span>
                  ),
                },
                {
                  title: "批次",
                  width: 200,
                  ellipsis: true,
                  render: (_value, row) => row.batch?.name || "未命名批次",
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
              pagination={{
                current: taskPage,
                pageSize: taskPageSize,
                total: taskTotal,
                showSizeChanger: true,
                pageSizeOptions: ["50", "100"],
                showTotal: (total) => `共 ${total} 条`,
                onChange: (page, pageSize) => {
                  setTaskPage(page);
                  setTaskPageSize(pageSize);
                  void load(
                    true,
                    trackedBatchIds,
                    page,
                    pageSize,
                    selectedBatchId,
                    taskExecutionFilter,
                  );
                },
              }}
            />
          </>
        ) : (
          <Result
            status="info"
            title="暂无审核任务"
            subTitle="创建审核任务后，审核进度和执行记录将在这里显示。"
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
          <>
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
              {isCombinedQueue ? "多个产品" : selectedBatch.product?.name || "-"}
            </Descriptions.Item>
            <Descriptions.Item label="所属活动">
              {isCombinedQueue ? "多个活动" : selectedBatch.campaign?.name || "-"}
            </Descriptions.Item>
            <Descriptions.Item label="产品阶段话题">
              {isCombinedQueue
                ? "多个批次"
                : productStageTopicLabel(selectedBatch.productStage)}
            </Descriptions.Item>
            <Descriptions.Item label="任务来源">
              {isCombinedQueue
                ? "多个批次"
                : businessSourceLabel(selectedBatch.source)}
            </Descriptions.Item>
            <Descriptions.Item label="本次笔记数">
              {selectedBatch.stats.total} 条
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
          </>
        ) : (
          <Result
            status="info"
            title="暂无审核任务"
            subTitle="创建审核任务后，审核进度和执行记录将在这里显示。"
          />
        )}
      </Card>
      <Modal
        title="清除当前批次？"
        open={Boolean(batchPendingClear)}
        okText="确认清除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        cancelButtonProps={{ disabled: Boolean(clearingBatchId) }}
        confirmLoading={Boolean(clearingBatchId)}
        closable={!clearingBatchId}
        maskClosable={!clearingBatchId}
        destroyOnHidden
        onOk={() => confirmClearSelectedBatch()}
        onCancel={() => {
          if (!clearingBatchId) setBatchPendingClear(null);
        }}
      >
        <p>
          清除后，该批次的审核进度、执行记录和任务内容将从审核任务页面移除。此操作不可撤销。
        </p>
      </Modal>
    </div>
  );
}
