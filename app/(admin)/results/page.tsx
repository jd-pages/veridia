"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { productStageTopicLabel } from "@/lib/product-stage";
import styles from "@/components/results/results-workbench.module.css";

const emptyFilters: ResultFilters = {
  productId: "",
  campaignId: "",
  month: "",
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
    month: filters.month,
    status: statusOverride === undefined ? filters.status : statusOverride,
    imageStatus: filters.imageStatus,
    keyword: filters.keyword,
    reason: filters.reason,
  };
  Object.entries(supported).forEach(([key, value]) => {
    if (value) query.set(key, value);
  });
  return query;
}

function isClientFilterActive(
  filters: ResultFilters,
  advanced: AdvancedResultFilters,
) {
  return Boolean(
    filters.manualStatus ||
      Object.values(advanced).some((value) => Boolean(value)),
  );
}

function applyClientFilters(
  rows: ResultRow[],
  filters: ResultFilters,
  advanced: AdvancedResultFilters,
) {
  return rows.filter((row) => {
    const manualResult = row.manualReviews[0]?.result;
    if (
      filters.manualStatus === "UNREVIEWED" &&
      row.manualReviews.length > 0
    ) {
      return false;
    }
    if (
      filters.manualStatus &&
      filters.manualStatus !== "UNREVIEWED" &&
      manualResult !== filters.manualStatus
    ) {
      return false;
    }
    if (advanced.pageStatus && row.pageStatus !== advanced.pageStatus) {
      return false;
    }
    if (advanced.bodyStatus && row.bodyStatus !== advanced.bodyStatus) {
      return false;
    }
    if (
      advanced.topicsStatus &&
      row.topicsCompliant !== (advanced.topicsStatus === "COMPLIANT")
    ) {
      return false;
    }
    if (
      advanced.clickableStatus &&
      row.clickableCompliant !==
        (advanced.clickableStatus === "COMPLIANT")
    ) {
      return false;
    }
    if (advanced.noteType && row.noteType !== advanced.noteType) {
      return false;
    }
    if (
      advanced.ruleVersion &&
      String(row.ruleVersion) !== advanced.ruleVersion.trim().replace(/^v/iu, "")
    ) {
      return false;
    }
    if (
      advanced.publicStatus &&
      row.publicStatus !== advanced.publicStatus
    ) {
      return false;
    }
    if (
      advanced.retentionStatus &&
      row.retentionStatus !== advanced.retentionStatus
    ) {
      return false;
    }
    return true;
  });
}

function ContentStatusCell({ row }: { row: ResultRow }) {
  const pageLabel =
    row.pageStatus === "NORMAL"
      ? "页面正常"
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
        label={row.bodyStatus === "PRESENT" ? "正文存在" : "正文为空"}
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
  const { message } = App.useApp();
  const [data, setData] = useState<ResultPageData>({
    total: 0,
    page: 1,
    pageSize: 20,
    items: [],
  });
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [filters, setFilters] = useState<ResultFilters>(emptyFilters);
  const [appliedFilters, setAppliedFilters] =
    useState<ResultFilters>(emptyFilters);
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
  const [drawerRow, setDrawerRow] = useState<ResultRow | null>(null);
  const [drawerDetail, setDrawerDetail] = useState<ResultDetail | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);

  const loadSummary = useCallback(async (targetFilters: ResultFilters) => {
    const summaryBase = { ...targetFilters, status: "" };
    const [all, passed, failed, review] = await Promise.all([
      apiFetch<ResultPageData>(
        `/api/results?${buildQuery(summaryBase, 1, 1, "")}`,
      ),
      apiFetch<ResultPageData>(
        `/api/results?${buildQuery(summaryBase, 1, 1, "PASSED")}`,
      ),
      apiFetch<ResultPageData>(
        `/api/results?${buildQuery(summaryBase, 1, 1, "FAILED")}`,
      ),
      apiFetch<ResultPageData>(
        `/api/results?${buildQuery(summaryBase, 1, 1, "NEEDS_REVIEW")}`,
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
    ) => {
      setLoading(true);
      try {
        const resultData = await apiFetch<ResultPageData>(
          `/api/results?${buildQuery(targetFilters, page, pageSize)}`,
        );
        setData(resultData);
        setSelected([]);
        setUpdatedAt(new Date());
        await loadSummary(targetFilters);
      } catch (error) {
        message.error(
          error instanceof Error ? error.message : "加载审核结果失败",
        );
      } finally {
        setLoading(false);
      }
    },
    [appliedFilters, loadSummary, message],
  );

  useEffect(() => {
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
    void load(1, 20, emptyFilters);
    // 页面首次加载一次；后续查询由用户操作显式触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleItems = useMemo(
    () =>
      applyClientFilters(
        data.items,
        appliedFilters,
        appliedAdvancedFilters,
      ),
    [appliedAdvancedFilters, appliedFilters, data.items],
  );
  const clientFiltersActive = isClientFilterActive(
    appliedFilters,
    appliedAdvancedFilters,
  );
  const visibleSummary = useMemo<ResultSummary>(() => {
    if (!clientFiltersActive) return summary;
    return {
      total: visibleItems.length,
      passed: visibleItems.filter((row) => row.autoStatus === "PASSED").length,
      failed: visibleItems.filter((row) => row.autoStatus === "FAILED").length,
      review: visibleItems.filter((row) => row.autoStatus === "NEEDS_REVIEW")
        .length,
    };
  }, [clientFiltersActive, summary, visibleItems]);

  const submitSearch = () => {
    setAppliedFilters(filters);
    setAppliedAdvancedFilters(advancedFilters);
    void load(1, data.pageSize, filters);
  };

  const resetFilters = () => {
    setFilters(emptyFilters);
    setAppliedFilters(emptyFilters);
    setAdvancedFilters(emptyAdvancedFilters);
    setAppliedAdvancedFilters(emptyAdvancedFilters);
    setAdvancedOpen(false);
    void load(1, data.pageSize, emptyFilters);
  };

  const selectSummary = (status: string) => {
    const next = { ...filters, status };
    setFilters(next);
    setAppliedFilters(next);
    setAppliedAdvancedFilters(advancedFilters);
    void load(1, data.pageSize, next);
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
    () => buildQuery(appliedFilters, 1, data.pageSize),
    [appliedFilters, data.pageSize],
  );
  exportQuery.delete("page");
  exportQuery.delete("pageSize");

  const exportSelected = () => {
    const selectedRows = data.items.filter((row) => selected.includes(row.id));
    if (!selectedRows.length) {
      message.warning("请先选择审核结果");
      return;
    }
    selectedRows.forEach((row, index) => {
      window.setTimeout(() => {
        const query = new URLSearchParams({
          keyword: row.note.platformNoteId || row.note.url,
        });
        const link = document.createElement("a");
        link.href = `/api/results/export?${query}`;
        link.target = "_blank";
        link.rel = "noreferrer";
        document.body.appendChild(link);
        link.click();
        link.remove();
      }, index * 180);
    });
    message.success(
      selectedRows.length === 1
        ? "已开始导出所选结果"
        : `已开始逐条导出 ${selectedRows.length} 个结果文件`,
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

  const rowMenu = (row: ResultRow): MenuProps["items"] => [
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
      onClick: () => {
        const query = new URLSearchParams({
          keyword: row.note.platformNoteId || row.note.url,
        });
        window.open(`/api/results/export?${query}`, "_blank");
      },
    },
    {
      key: "raw",
      icon: <FileTextOutlined />,
      label: "查看原始提取数据",
      onClick: () => void openDrawer(row),
    },
  ];

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
              <Button
                className={styles.secondaryButton}
                icon={<DownloadOutlined />}
                onClick={() =>
                  window.open(`/api/results/export?${exportQuery}`, "_blank")
                }
              >
                导出当前结果
              </Button>
            </div>
          }
        />
      </div>

      <ResultSummaryCards
        summary={visibleSummary}
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

      <BatchActionBar
        selectedCount={selected.length}
        onAction={(action) => void bulk(action)}
        onExport={exportSelected}
        onClear={() => setSelected([])}
      />

      <section className={styles.tableCard} aria-label="审核结果列表">
        <div className={styles.tableHeader}>
          <div>
            <h2 className={styles.tableTitle}>审核结果列表</h2>
            <div className={styles.tableMeta}>
              自动结论与人工复核分别展示，不互相覆盖
            </div>
          </div>
          <div className={styles.tableMeta}>
            {clientFiltersActive
              ? `当前页筛选 ${visibleItems.length} 条`
              : `当前筛选共 ${data.total} 条`}
          </div>
        </div>
        <StickyHorizontalScrollbar>
          <Table<ResultRow>
            rowKey="id"
            loading={loading}
            dataSource={visibleItems}
            rowSelection={{
              fixed: true,
              selectedRowKeys: selected,
              onChange: setSelected,
              columnWidth: 48,
            }}
            columns={columns}
            scroll={{ x: 1740 }}
            sticky={{ offsetHeader: 64, offsetScroll: 10 }}
            pagination={{
              current: clientFiltersActive ? 1 : data.page,
              pageSize: data.pageSize,
              total: clientFiltersActive ? visibleItems.length : data.total,
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
      />
    </div>
  );
}
