"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  App,
  Button,
  Dropdown,
  Space,
  Table,
  Tag,
  Tooltip,
  type MenuProps,
  type TableColumnsType,
} from "antd";
import {
  CheckOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EllipsisOutlined,
  ExportOutlined,
  EyeOutlined,
  FileTextOutlined,
  ReloadOutlined,
  RightOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";
import dayjs from "dayjs";
import PageHeader from "@/components/PageHeader";
import AuditConclusionCell from "@/components/results/AuditConclusionCell";
import AuditDetailDrawer from "@/components/results/AuditDetailDrawer";
import AuditFilterPanel from "@/components/results/AuditFilterPanel";
import AuditStatusTag from "@/components/results/AuditStatusTag";
import BatchActionBar from "@/components/results/BatchActionBar";
import ImageAuditCell from "@/components/results/ImageAuditCell";
import NoteObjectCell from "@/components/results/NoteObjectCell";
import ResultSummaryCards from "@/components/results/ResultSummaryCards";
import StickyHorizontalScrollbar from "@/components/results/StickyHorizontalScrollbar";
import TopicAuditCell from "@/components/results/TopicAuditCell";
import type {
  AdvancedResultFilters,
  BulkAction,
  CampaignOption,
  ProductOption,
  ResultDetail,
  ResultFilters,
  ResultPageData,
  ResultRow,
  ResultSummary,
} from "@/components/results/types";
import { apiFetch } from "@/lib/client";
import {
  exportResultFile,
  ResultExportError,
} from "@/lib/result-export-client";
import { productStageTopicLabel } from "@/lib/product-stage";
import { auditResultListDisplay } from "@/lib/result-display";
import { pageAfterResultDeletion } from "@/components/results/deletion-state";
import type { SessionUser } from "@/lib/auth";
import styles from "@/components/results/results-workbench.module.css";

const defaultFilters: ResultFilters = {
  productId: "",
  campaignId: "",
  startDate: dayjs().startOf("month").format("YYYY-MM-DD"),
  endDate: dayjs().endOf("month").format("YYYY-MM-DD"),
  dateType: "AUDITED_AT",
  status: "",
  imageStatus: "",
  keyword: "",
  reason: "",
  manualStatus: "",
};

const emptyAdvancedFilters: AdvancedResultFilters = {
  pageStatus: "",
  bodyStatus: "",
  topicsStatus: "",
  clickableStatus: "",
  noteType: "",
  ruleVersion: "",
  publicStatus: "",
  retentionStatus: "",
};

function buildQuery(
  filters: ResultFilters,
  advanced: AdvancedResultFilters,
  page: number,
  pageSize: number,
  statusOverride?: string,
) {
  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });
  const supported = {
    productId: filters.productId,
    campaignId: filters.campaignId,
    startDate: filters.startDate,
    endDate: filters.endDate,
    dateType: filters.dateType,
    status: statusOverride === undefined ? filters.status : statusOverride,
    manualStatus: filters.manualStatus,
    imageStatus: filters.imageStatus,
    keyword: filters.keyword,
    reason: filters.reason,
    pageStatus: advanced.pageStatus,
    bodyStatus: advanced.bodyStatus,
    topicsStatus: advanced.topicsStatus,
    clickableStatus: advanced.clickableStatus,
    noteType: advanced.noteType,
    ruleVersion: advanced.ruleVersion,
    publicStatus: advanced.publicStatus,
    retentionStatus: advanced.retentionStatus,
  };
  Object.entries(supported).forEach(([key, value]) => {
    if (value) query.set(key, value);
  });
  return query;
}

function ContentStatusCell({ row }: { row: ResultRow }) {
  const unavailableDisplay = auditResultListDisplay(row);
  if (unavailableDisplay) {
    return (
      <span className={styles.cellPrimary}>
        {unavailableDisplay.contentStatus}
      </span>
    );
  }

  const pageLabel =
    row.pageStatus === "NORMAL"
      ? "页面正常"
      : row.pageStatus === "NOT_FOUND"
        ? "页面失效"
        : row.pageStatus === "DELETED"
          ? "笔记已删除"
      : row.pageStatus === "READ_FAILED"
        ? "读取失败"
        : row.pageStatus === "NO_PERMISSION"
          ? "不可访问"
          : undefined;
  return (
    <div className={styles.inlineMeta}>
      <AuditStatusTag value={row.pageStatus} label={pageLabel} />
      <AuditStatusTag
        value={row.bodyStatus}
        label={
          row.bodyStatus === "PRESENT"
            ? "正文存在"
            : row.bodyStatus === "UNKNOWN"
              ? "未提取到正文 / 待人工确认"
              : "正文为空"
        }
      />
      <AuditStatusTag value={row.noteType} />
      <AuditStatusTag
        value={row.publicStatus}
        label={
          row.publicStatus === "PUBLIC"
            ? "公开"
            : row.publicStatus === "NOT_PUBLIC"
              ? "不公开"
              : undefined
        }
      />
    </div>
  );
}

export default function ResultsPage() {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [data, setData] = useState<ResultPageData>({
    total: 0,
    page: 1,
    pageSize: 20,
    items: [],
  });
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [filters, setFilters] = useState<ResultFilters>(defaultFilters);
  const [appliedFilters, setAppliedFilters] =
    useState<ResultFilters>(defaultFilters);
  const [advancedFilters, setAdvancedFilters] =
    useState<AdvancedResultFilters>(emptyAdvancedFilters);
  const [appliedAdvancedFilters, setAppliedAdvancedFilters] =
    useState<AdvancedResultFilters>(emptyAdvancedFilters);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [summary, setSummary] = useState<ResultSummary>({
    total: 0,
    passed: 0,
    failed: 0,
    review: 0,
  });
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<React.Key[]>([]);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [exporting, setExporting] = useState(false);
  const exportLockRef = useRef(false);
  const [deletingIds, setDeletingIds] = useState<React.Key[]>([]);
  const deleteLockRef = useRef(false);
  const [drawerRow, setDrawerRow] = useState<ResultRow | null>(null);
  const [drawerDetail, setDrawerDetail] = useState<ResultDetail | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [currentRole, setCurrentRole] = useState<SessionUser["role"] | null>(
    null,
  );
  const canOperate = currentRole === "ADMIN" || currentRole === "OPERATOR";
  const canDelete = currentRole === "ADMIN";

  const loadSummary = useCallback(async (
    targetFilters: ResultFilters,
    targetAdvancedFilters: AdvancedResultFilters,
  ) => {
    const summaryBase = { ...targetFilters, status: "" };
    const [all, passed, failed, review] = await Promise.all([
      apiFetch<ResultPageData>(
        `/api/results?${buildQuery(summaryBase, targetAdvancedFilters, 1, 1, "")}`,
      ),
      apiFetch<ResultPageData>(
        `/api/results?${buildQuery(summaryBase, targetAdvancedFilters, 1, 1, "PASSED")}`,
      ),
      apiFetch<ResultPageData>(
        `/api/results?${buildQuery(summaryBase, targetAdvancedFilters, 1, 1, "FAILED")}`,
      ),
      apiFetch<ResultPageData>(
        `/api/results?${buildQuery(summaryBase, targetAdvancedFilters, 1, 1, "NEEDS_REVIEW")}`,
      ),
    ]);
    setSummary({
      total: all.total,
      passed: passed.total,
      failed: failed.total,
      review: review.total,
    });
  }, []);

  const load = useCallback(
    async (
      page = 1,
      pageSize = 20,
      targetFilters: ResultFilters = appliedFilters,
      targetAdvancedFilters: AdvancedResultFilters =
        appliedAdvancedFilters,
    ) => {
      setLoading(true);
      try {
        const resultData = await apiFetch<ResultPageData>(
          `/api/results?${buildQuery(targetFilters, targetAdvancedFilters, page, pageSize)}`,
        );
        setData(resultData);
        setSelected([]);
        setUpdatedAt(new Date());
        await loadSummary(targetFilters, targetAdvancedFilters);
      } catch (error) {
        message.error(
          error instanceof Error ? error.message : "加载审核结果失败",
        );
      } finally {
        setLoading(false);
      }
    },
    [appliedAdvancedFilters, appliedFilters, loadSummary, message],
  );

  useEffect(() => {
    void apiFetch<SessionUser | null>("/api/auth/me").then((user) =>
      setCurrentRole(user?.role || null),
    );
    void Promise.all([
      apiFetch<ProductOption[]>("/api/products"),
      apiFetch<CampaignOption[]>("/api/campaigns"),
    ])
      .then(([productData, campaignData]) => {
        setProducts(productData);
        setCampaigns(campaignData);
      })
      .catch((error) =>
        message.error(
          error instanceof Error ? error.message : "加载筛选项失败",
        ),
      );
    void load(1, 20, defaultFilters, emptyAdvancedFilters);
    // 页面首次加载一次；后续查询由用户操作显式触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleItems = data.items;

  const submitSearch = () => {
    setAppliedFilters(filters);
    setAppliedAdvancedFilters(advancedFilters);
    void load(1, data.pageSize, filters, advancedFilters);
  };

  const resetFilters = () => {
    setFilters(defaultFilters);
    setAppliedFilters(defaultFilters);
    setAdvancedFilters(emptyAdvancedFilters);
    setAppliedAdvancedFilters(emptyAdvancedFilters);
    setAdvancedOpen(false);
    void load(
      1,
      data.pageSize,
      defaultFilters,
      emptyAdvancedFilters,
    );
  };

  const selectSummary = (status: string) => {
    const next = { ...filters, status };
    setFilters(next);
    setAppliedFilters(next);
    setAppliedAdvancedFilters(advancedFilters);
    void load(1, data.pageSize, next, advancedFilters);
  };

  const bulk = async (action: BulkAction, ids = selected) => {
    if (!ids.length) {
      message.warning("请先选择审核结果");
      return;
    }
    try {
      const result = await apiFetch<{
        completed: number;
        errors: unknown[];
      }>("/api/results/bulk", {
        method: "POST",
        body: JSON.stringify({ ids, action }),
      });
      message.success(`已处理 ${result.completed} 条`);
      setSelected([]);
      await load(data.page, data.pageSize, appliedFilters);
      if (drawerRow && ids.includes(drawerRow.id)) {
        setDrawerRow(null);
        setDrawerDetail(null);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "批量操作失败");
    }
  };

  const exportQuery = useMemo(
    () =>
      buildQuery(
        appliedFilters,
        appliedAdvancedFilters,
        1,
        data.pageSize,
      ),
    [appliedAdvancedFilters, appliedFilters, data.pageSize],
  );
  exportQuery.delete("page");
  exportQuery.delete("pageSize");

  const runExport = useCallback(
    async (query: URLSearchParams) => {
      if (exportLockRef.current) return;
      exportLockRef.current = true;
      setExporting(true);
      try {
        const outcome = await exportResultFile(query);
        if (outcome.canceled) {
          message.info("已取消保存");
        } else if (outcome.saved) {
          message.success(`导出成功，共 ${outcome.count} 条`);
        }
      } catch (error) {
        if (
          error instanceof ResultExportError &&
          error.code === "NO_EXPORT_RESULTS"
        ) {
          message.warning("当前筛选无结果，未生成文件");
        } else {
          message.error(error instanceof Error ? error.message : "导出失败");
        }
      } finally {
        exportLockRef.current = false;
        setExporting(false);
      }
    },
    [message],
  );

  const exportCurrent = () => {
    if (data.total < 1) {
      message.warning("当前筛选无结果，未生成文件");
      return;
    }
    void runExport(exportQuery);
  };

  const exportSelected = () => {
    if (!selected.length) {
      message.warning("请先选择审核结果");
      return;
    }
    void runExport(
      new URLSearchParams({ ids: selected.map(String).join(",") }),
    );
  };

  const openDrawer = async (row: ResultRow) => {
    setDrawerRow(row);
    setDrawerDetail(null);
    setDrawerLoading(true);
    try {
      setDrawerDetail(await apiFetch<ResultDetail>(`/api/results/${row.id}`));
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : "加载审核详情失败",
      );
    } finally {
      setDrawerLoading(false);
    }
  };

  const deleteResults = async (
    ids: React.Key[],
    mode: "SINGLE" | "BULK",
  ) => {
    if (deleteLockRef.current || !ids.length) return;
    deleteLockRef.current = true;
    setDeletingIds(ids);
    try {
      const result =
        mode === "SINGLE"
          ? await apiFetch<{ deletedCount: number; deletedIds: string[] }>(
              `/api/results/${encodeURIComponent(String(ids[0]))}`,
              { method: "DELETE" },
            )
          : await apiFetch<{ deletedCount: number; deletedIds: string[] }>(
              "/api/results/batch-delete",
              {
                method: "POST",
                body: JSON.stringify({ ids: ids.map(String) }),
              },
            );

      if (drawerRow && result.deletedIds.includes(drawerRow.id)) {
        setDrawerRow(null);
        setDrawerDetail(null);
      }
      setSelected([]);
      const targetPage = pageAfterResultDeletion({
        total: data.total,
        page: data.page,
        pageSize: data.pageSize,
        deletedCount: result.deletedCount,
      });
      await load(
        targetPage,
        data.pageSize,
        appliedFilters,
        appliedAdvancedFilters,
      );
      message.success(`已成功删除 ${result.deletedCount} 条审核结果`);
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : "删除审核结果失败",
      );
      throw error;
    } finally {
      deleteLockRef.current = false;
      setDeletingIds([]);
    }
  };

  const confirmDelete = (ids: React.Key[], mode: "SINGLE" | "BULK") => {
    if (!canDelete || !ids.length || deleteLockRef.current) return;
    const count = ids.length;
    modal.confirm({
      title:
        mode === "SINGLE" ? "确认删除该审核结果？" : "确认批量删除？",
      content:
        mode === "SINGLE"
          ? "删除后，该审核结果及其关联审核明细将无法恢复，但不会删除原审核任务、导入记录、产品、活动或规则。"
          : `即将删除已选择的 ${count} 条审核结果及其关联审核明细，删除后无法恢复。`,
      cancelText: "取消",
      okText: "确认删除",
      okButtonProps: { danger: true },
      onOk: () => deleteResults(ids, mode),
    });
  };

  const rowMenu = (row: ResultRow): MenuProps["items"] => {
    const readOnlyItems: MenuProps["items"] = [
      {
        key: "open",
        icon: <ExportOutlined />,
        label: (
          <a href={row.note.url} target="_blank" rel="noreferrer">
            打开原笔记
          </a>
        ),
      },
      {
        key: "raw",
        icon: <FileTextOutlined />,
        label: "查看原始提取数据",
        onClick: () => void openDrawer(row),
      },
    ];
    if (!canOperate) return readOnlyItems;
    const items: MenuProps["items"] = [
      {
        key: "reaudit",
        icon: <ReloadOutlined />,
        label: "重新审核",
        onClick: () => void bulk("RE_AUDIT", [row.id]),
      },
      {
        key: "pass",
        icon: <CheckOutlined />,
        label: "人工通过",
        onClick: () => void bulk("MANUAL_PASS", [row.id]),
      },
      {
        key: "fail",
        icon: <StopOutlined />,
        danger: true,
        label: "人工不通过",
        onClick: () => void bulk("MANUAL_FAIL", [row.id]),
      },
      { type: "divider" },
      {
        key: "open",
        icon: <ExportOutlined />,
        label: (
          <a href={row.note.url} target="_blank" rel="noreferrer">
            打开原笔记
          </a>
        ),
      },
      {
        key: "export",
        icon: <DownloadOutlined />,
        label: "导出单条",
        onClick: () =>
          void runExport(new URLSearchParams({ ids: row.id })),
      },
      {
        key: "raw",
        icon: <FileTextOutlined />,
        label: "查看原始提取数据",
        onClick: () => void openDrawer(row),
      },
    ];
    if (canDelete) {
      items.push(
        { type: "divider" },
        {
          key: "delete",
          danger: true,
          icon: <DeleteOutlined />,
          label: "删除该结果",
          onClick: () => confirmDelete([row.id], "SINGLE"),
        },
      );
    }
    return items;
  };

  const columns: TableColumnsType<ResultRow> = [
    {
      title: "笔记对象",
      key: "note",
      width: 275,
      fixed: "left",
      render: (_value, row) => <NoteObjectCell row={row} />,
    },
    {
      title: "归属信息",
      key: "ownership",
      width: 260,
      render: (_value, row) => (
        <div className={styles.stack}>
          <div className={styles.cellPrimary}>{row.task.product.name}</div>
          <Tooltip title={row.task.campaign.name}>
            <div className={styles.cellSecondary}>
              {row.task.campaign.name}
            </div>
          </Tooltip>
          <div>
            <Tag className={`${styles.compactTag} ${styles.neutralTag}`}>
              {productStageTopicLabel(row.task.productStage)}
            </Tag>
          </div>
        </div>
      ),
    },
    {
      title: "内容状态",
      key: "content",
      width: 255,
      render: (_value, row) => <ContentStatusCell row={row} />,
    },
    {
      title: "话题审核",
      key: "topics",
      width: 220,
      render: (_value, row) => <TopicAuditCell row={row} />,
    },
    {
      title: "图片",
      key: "images",
      width: 155,
      render: (_value, row) => <ImageAuditCell row={row} />,
    },
    {
      title: "审核结论",
      key: "conclusion",
      width: 265,
      render: (_value, row) => <AuditConclusionCell row={row} />,
    },
    {
      title: "操作",
      key: "actions",
      width: 150,
      fixed: "right",
      render: (_value, row) => (
        <Space size={4}>
          <Button
            type="text"
            className={styles.primaryAction}
            icon={<EyeOutlined />}
            onClick={() => void openDrawer(row)}
          >
            查看详情 <RightOutlined />
          </Button>
          <Dropdown
            menu={{ items: rowMenu(row) }}
            trigger={["click"]}
            placement="bottomRight"
          >
            <Button
              type="text"
              aria-label="更多操作"
              icon={<EllipsisOutlined />}
            />
          </Dropdown>
        </Space>
      ),
    },
  ];

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <PageHeader
          title="审核结果"
          description="查看自动审核结论、异常原因及人工复核记录"
          actions={
            <div className={styles.headerActions}>
              <span className={styles.updatedAt}>
                {updatedAt
                  ? `更新于 ${updatedAt.toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`
                  : "正在读取最新数据"}
              </span>
              <Button
                icon={<ReloadOutlined />}
                onClick={() =>
                  void load(data.page, data.pageSize, appliedFilters)
                }
              >
                刷新数据
              </Button>
              {canOperate && (
                <Button
                  className={styles.secondaryButton}
                  icon={<DownloadOutlined />}
                  loading={exporting}
                  disabled={exporting}
                  onClick={exportCurrent}
                >
                  {exporting ? "导出中..." : "导出当前结果"}
                </Button>
              )}
            </div>
          }
        />
      </div>

      <ResultSummaryCards
        summary={summary}
        activeStatus={filters.status}
        onSelect={selectSummary}
      />

      <AuditFilterPanel
        filters={filters}
        advancedFilters={advancedFilters}
        products={products}
        campaigns={campaigns}
        advancedOpen={advancedOpen}
        onFiltersChange={setFilters}
        onAdvancedFiltersChange={setAdvancedFilters}
        onAdvancedOpenChange={setAdvancedOpen}
        onSearch={submitSearch}
        onReset={resetFilters}
      />

      {canOperate && <BatchActionBar
        selectedCount={selected.length}
        canDelete={canDelete}
        deleting={deletingIds.length > 0}
        onAction={(action) => void bulk(action)}
        onExport={exportSelected}
        onDelete={() => confirmDelete(selected, "BULK")}
        onClear={() => setSelected([])}
      />}

      <section className={styles.tableCard} aria-label="审核结果列表">
        <div className={styles.tableHeader}>
          <div>
            <h2 className={styles.tableTitle}>审核结果列表</h2>
            <div className={styles.tableMeta}>
              自动结论与人工复核分别展示，不互相覆盖
            </div>
          </div>
          <div className={styles.tableMeta}>
            当前筛选共 {data.total} 条
          </div>
        </div>
        <StickyHorizontalScrollbar>
          <Table<ResultRow>
            rowKey="id"
            loading={loading}
            dataSource={visibleItems}
            rowSelection={canOperate ? {
              fixed: true,
              selectedRowKeys: selected,
              onChange: setSelected,
              columnWidth: 48,
            } : undefined}
            columns={columns}
            scroll={{ x: 1740 }}
            sticky={{ offsetHeader: 64, offsetScroll: 10 }}
            pagination={{
              current: data.page,
              pageSize: data.pageSize,
              total: data.total,
              showSizeChanger: true,
              showTotal: (total) => `共 ${total} 条`,
              pageSizeOptions: [10, 20, 50, 100],
              onChange: (page, pageSize) =>
                void load(page, pageSize, appliedFilters),
            }}
          />
        </StickyHorizontalScrollbar>
      </section>

      <AuditDetailDrawer
        open={Boolean(drawerRow)}
        row={drawerRow}
        detail={drawerDetail}
        loading={drawerLoading}
        onClose={() => {
          setDrawerRow(null);
          setDrawerDetail(null);
        }}
        onOpenFullDetail={(row) => router.push(`/results/${row.id}`)}
        onAction={(row, action) => void bulk(action, [row.id])}
        canOperate={canOperate}
      />
    </div>
  );
}
