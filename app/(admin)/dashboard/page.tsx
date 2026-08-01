"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Progress,
  Segmented,
  Select,
  Skeleton,
  Tooltip,
} from "antd";
import {
  AuditOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  FileSearchOutlined,
  LinkOutlined,
  PictureOutlined,
  ReloadOutlined,
  RightOutlined,
  SettingOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/client";
import {
  businessFailureReasonLabel,
  businessUiText,
} from "@/lib/zh-CN";
import styles from "./dashboard.module.css";

interface DashboardData {
  total: number;
  passed: number;
  failed: number;
  needsReview: number;
  readFailed: number;
  topicMissing: number;
  clickableAbnormal: number;
  passRate: number;
  reasonRanking: Array<{ reason: string; count: number }>;
}

interface Product {
  id: string;
  name: string;
}

interface Campaign {
  id: string;
  name: string;
  month: string;
  productId: string | null;
  products?: Array<{ product: Product }>;
  _count: { topicRules: number };
}

interface AuditBatch {
  id: string;
  name: string | null;
  status: string;
  createdAt: string;
  stats: {
    total: number;
    progress: number;
  };
}

type CoreMetricKey = "total" | "passed" | "failed" | "needsReview";

const coreMetrics: Array<{
  key: CoreMetricKey;
  label: string;
  icon: React.ReactNode;
  tone: "slate" | "green" | "red" | "purple";
  status?: string;
}> = [
  {
    key: "total",
    label: "本月审核总数",
    icon: <FileSearchOutlined />,
    tone: "slate",
  },
  {
    key: "passed",
    label: "审核通过",
    icon: <CheckCircleOutlined />,
    tone: "green",
    status: "PASSED",
  },
  {
    key: "failed",
    label: "审核不通过",
    icon: <CloseCircleOutlined />,
    tone: "red",
    status: "FAILED",
  },
  {
    key: "needsReview",
    label: "待人工复核",
    icon: <AuditOutlined />,
    tone: "purple",
    status: "NEEDS_REVIEW",
  },
];

const reasonTones = ["#e5484d", "#8f1d27", "#e66a45", "#8d99aa", "#aab3c2"];

function percentage(value: number, total: number) {
  return total ? Math.round((value / total) * 1000) / 10 : 0;
}

function formatUpdatedAt(date: Date) {
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [batches, setBatches] = useState<AuditBatch[]>([]);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [productId, setProductId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [trendRange, setTrendRange] = useState<"7天" | "30天">("7天");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const [dashboard, productItems, campaignItems, batchItems] =
      await Promise.allSettled([
        apiFetch<DashboardData>("/api/dashboard"),
        apiFetch<Product[]>("/api/products"),
        apiFetch<Campaign[]>("/api/campaigns"),
        apiFetch<AuditBatch[]>("/api/automation/batches"),
      ]);
    if (dashboard.status === "fulfilled") setData(dashboard.value);
    if (productItems.status === "fulfilled") setProducts(productItems.value);
    if (campaignItems.status === "fulfilled") setCampaigns(campaignItems.value);
    if (batchItems.status === "fulfilled") setBatches(batchItems.value);
    const failure = [dashboard, productItems, campaignItems].find(
      (result) => result.status === "rejected",
    );
    if (failure?.status === "rejected") {
      setError(
        failure.reason instanceof Error
          ? failure.reason.message
          : "数据读取失败，请刷新或重启 VERIDIA。",
      );
    } else {
      setUpdatedAt(new Date());
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredCampaigns = useMemo(
    () =>
      campaigns.filter((campaign) => {
        if (month && campaign.month !== month) return false;
        if (!productId) return true;
        return (
          campaign.productId === productId ||
          campaign.products?.some(({ product }) => product.id === productId)
        );
      }),
    [campaigns, month, productId],
  );

  const monthOptions = useMemo(
    () =>
      [...new Set(campaigns.map((campaign) => campaign.month))]
        .sort()
        .reverse()
        .map((value) => ({ value, label: value })),
    [campaigns],
  );

  const filterParams = useMemo(
    () => ({
      ...(month ? { month } : {}),
      ...(productId ? { productId } : {}),
      ...(campaignId ? { campaignId } : {}),
    }),
    [campaignId, month, productId],
  );

  const openResults = useCallback(
    (extra: Record<string, string> = {}) => {
      const query = new URLSearchParams({ ...filterParams, ...extra });
      router.push(`/results${query.size ? `?${query.toString()}` : ""}`);
    },
    [filterParams, router],
  );

  const imageInsufficient = useMemo(
    () =>
      data?.reasonRanking
        .filter((item) => /图片数量不足|图片不足/u.test(item.reason))
        .reduce((sum, item) => sum + item.count, 0) ?? 0,
    [data],
  );

  const incompleteCampaigns = campaigns.filter(
    (campaign) => campaign._count.topicRules === 0,
  ).length;

  const topReasons = data?.reasonRanking.slice(0, 5) ?? [];
  const distributionTotal = data
    ? data.passed + data.failed + data.needsReview
    : 0;
  const passedDegree = distributionTotal
    ? (data!.passed / distributionTotal) * 360
    : 0;
  const failedDegree = distributionTotal
    ? (data!.failed / distributionTotal) * 360
    : 0;
  const ringBackground = distributionTotal
    ? `conic-gradient(#159467 0deg ${passedDegree}deg, #e5484d ${passedDegree}deg ${
        passedDegree + failedDegree
      }deg, #8067b7 ${passedDegree + failedDegree}deg 360deg)`
    : "#e9edf3";

  const riskItems = data
    ? [
        {
          label: "读取失败",
          value: data.readFailed,
          icon: <ReloadOutlined />,
          tone: "orange",
          onClick: () => openResults({ status: "READ_FAILED" }),
        },
        {
          label: "话题缺失",
          value: data.topicMissing,
          icon: <WarningOutlined />,
          tone: "red",
          onClick: () => openResults({ reason: "缺少" }),
        },
        {
          label: "蓝色话题异常",
          value: data.clickableAbnormal,
          icon: <LinkOutlined />,
          tone: "blue",
          onClick: () => openResults({ reason: "可点击" }),
        },
        {
          label: "图片不足",
          value: imageInsufficient,
          icon: <PictureOutlined />,
          tone: "purple",
          onClick: () => openResults({ reason: "图片数量不足" }),
        },
      ]
    : [];

  return (
    <div className={styles.workspace}>
      <header className={styles.pageHeader}>
        <div className={styles.headingGroup}>
          <div className={styles.breadcrumb}>笔记合规中心 / 审核工作台</div>
          <h1>审核工作台</h1>
          <p>掌握审核进度、风险分布与待处理任务</p>
        </div>
        <div className={styles.headerActions}>
          <Tooltip title="筛选条件将自动带入下钻结果；核心指标保持既有本月统计口径">
            <div className={styles.filterGroup}>
              <Select
                aria-label="月份筛选"
                value={month || undefined}
                placeholder="月份"
                options={monthOptions}
                onChange={(value) => {
                  setMonth(value || "");
                  setCampaignId("");
                }}
                className={styles.monthSelect}
              />
              <Select
                aria-label="产品筛选"
                allowClear
                showSearch
                optionFilterProp="label"
                value={productId || undefined}
                placeholder="全部产品"
                options={products.map((product) => ({
                  value: product.id,
                  label: product.name,
                }))}
                onChange={(value) => {
                  setProductId(value || "");
                  setCampaignId("");
                }}
                className={styles.productSelect}
              />
              <Select
                aria-label="活动筛选"
                allowClear
                showSearch
                optionFilterProp="label"
                value={campaignId || undefined}
                placeholder="全部活动"
                options={filteredCampaigns.map((campaign) => ({
                  value: campaign.id,
                  label: campaign.name,
                }))}
                onChange={(value) => setCampaignId(value || "")}
                className={styles.campaignSelect}
              />
            </div>
          </Tooltip>
          <Button
            aria-label="刷新仪表盘数据"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => void load()}
            className={styles.refreshButton}
          >
            刷新
          </Button>
          <div className={styles.updateStatus}>
            <span className={styles.statusDot} />
            数据已更新 {updatedAt ? formatUpdatedAt(updatedAt) : "--:--"}
          </div>
        </div>
      </header>

      {error ? <Alert message={error} type="error" showIcon /> : null}

      {!data ? (
        <section className={styles.loadingCard}>
          <Skeleton active />
        </section>
      ) : (
        <>
          <section className={styles.coreGrid} aria-label="核心审核指标">
            {coreMetrics.map((metric) => {
              const value = data[metric.key];
              const ratio =
                metric.key === "total" ? 100 : percentage(value, data.total);
              return (
                <button
                  type="button"
                  key={metric.key}
                  className={`${styles.metricCard} ${styles[metric.tone]}`}
                  onClick={() =>
                    openResults(metric.status ? { status: metric.status } : {})
                  }
                >
                  <span className={styles.metricIcon}>{metric.icon}</span>
                  <span className={styles.metricContent}>
                    <span className={styles.metricName}>{metric.label}</span>
                    <strong>{value.toLocaleString("zh-CN")}</strong>
                    <span className={styles.metricMeta}>
                      <span>占审核总量 {ratio}%</span>
                      <span>较上周期 —</span>
                    </span>
                  </span>
                  <RightOutlined className={styles.metricArrow} />
                </button>
              );
            })}
          </section>

          <section className={styles.riskSummary} aria-label="风险摘要">
            <div className={styles.sectionLead}>
              <div>
                <span className={styles.eyebrow}>{businessUiText.riskSummary}</span>
                <h2>风险摘要</h2>
              </div>
              <span>点击指标查看对应审核明细</span>
            </div>
            <div className={styles.riskItems}>
              {riskItems.map((item) => (
                <button
                  type="button"
                  key={item.label}
                  onClick={item.onClick}
                  className={`${styles.riskItem} ${styles[item.tone]}`}
                >
                  <span className={styles.riskIcon}>{item.icon}</span>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                  <RightOutlined />
                </button>
              ))}
            </div>
          </section>

          <section className={styles.analyticsGrid}>
            <article className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <span className={styles.eyebrow}>{businessUiText.auditTrend}</span>
                  <h2>最近{trendRange}审核趋势</h2>
                </div>
                <Segmented
                  size="small"
                  value={trendRange}
                  options={["7天", "30天"]}
                  onChange={(value) => setTrendRange(value as "7天" | "30天")}
                />
              </div>
              <div className={styles.trendLegend}>
                <span><i className={styles.slateDot} />审核总量</span>
                <span><i className={styles.greenDot} />审核通过</span>
                <span><i className={styles.redDot} />审核不通过</span>
              </div>
              <div className={styles.trendEmpty}>
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={`现有统计接口暂未提供按日${trendRange}趋势数据`}
                />
              </div>
            </article>

            <article className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <span className={styles.eyebrow}>{businessUiText.resultMix}</span>
                  <h2>审核结果分布</h2>
                </div>
              </div>
              <div className={styles.distributionLayout}>
                <div
                  className={styles.distributionRing}
                  style={{ background: ringBackground }}
                  aria-label={`总体通过率 ${data.passRate}%`}
                >
                  <div>
                    <span>总体通过率</span>
                    <strong>{data.passRate}%</strong>
                  </div>
                </div>
                <div className={styles.distributionLegend}>
                  <button type="button" onClick={() => openResults({ status: "PASSED" })}>
                    <i className={styles.greenDot} />
                    <span>通过</span>
                    <strong>{data.passed}</strong>
                  </button>
                  <button type="button" onClick={() => openResults({ status: "FAILED" })}>
                    <i className={styles.redDot} />
                    <span>不通过</span>
                    <strong>{data.failed}</strong>
                  </button>
                  <button
                    type="button"
                    onClick={() => openResults({ status: "NEEDS_REVIEW" })}
                  >
                    <i className={styles.purpleDot} />
                    <span>待复核</span>
                    <strong>{data.needsReview}</strong>
                  </button>
                </div>
              </div>
            </article>
          </section>

          <section className={styles.actionGrid}>
            <article className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <span className={styles.eyebrow}>{businessUiText.topRisks}</span>
                  <h2>常见不通过原因前五项</h2>
                </div>
                <button
                  type="button"
                  className={styles.textLink}
                  onClick={() => openResults({ status: "FAILED" })}
                >
                  查看全部 <RightOutlined />
                </button>
              </div>
              {topReasons.length ? (
                <div className={styles.reasonList}>
                  {topReasons.map((item, index) => {
                    const ratio = percentage(item.count, data.failed);
                    return (
                      <button
                        type="button"
                        key={item.reason}
                        className={styles.reasonItem}
                        onClick={() => openResults({ reason: item.reason })}
                      >
                        <span
                          className={styles.rank}
                          style={{
                            color: index < 3 ? reasonTones[index] : "#667085",
                            backgroundColor: `${reasonTones[index]}14`,
                          }}
                        >
                          {index + 1}
                        </span>
                        <span className={styles.reasonMain}>
                          <span className={styles.reasonHeading}>
                            <span>{businessFailureReasonLabel(item.reason)}</span>
                            <span>
                              <strong>{item.count}</strong> 次 · {ratio}%
                            </span>
                          </span>
                          <Progress
                            percent={Math.min(ratio, 100)}
                            showInfo={false}
                            strokeColor={reasonTones[index]}
                            trailColor="#eef1f5"
                            size="small"
                          />
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className={styles.panelEmpty}>
                  <Empty description="本月暂无不通过原因" />
                </div>
              )}
            </article>

            <article className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <span className={styles.eyebrow}>{businessUiText.actionCenter}</span>
                  <h2>待处理事项</h2>
                </div>
              </div>
              <div className={styles.todoList}>
                <button
                  type="button"
                  onClick={() => openResults({ status: "NEEDS_REVIEW" })}
                >
                  <span className={`${styles.todoIcon} ${styles.purple}`}>
                    <AuditOutlined />
                  </span>
                  <span>
                    <strong>待人工复核</strong>
                    <small>需要运营确认审核结论</small>
                  </span>
                  <b>{data.needsReview}</b>
                  <RightOutlined />
                </button>
                <button
                  type="button"
                  onClick={() => openResults({ status: "READ_FAILED" })}
                >
                  <span className={`${styles.todoIcon} ${styles.orange}`}>
                    <ReloadOutlined />
                  </span>
                  <span>
                    <strong>读取失败待重试</strong>
                    <small>页面读取异常，可重新执行</small>
                  </span>
                  <b>{data.readFailed}</b>
                  <RightOutlined />
                </button>
                <button
                  type="button"
                  onClick={() => openResults({ reason: "公开留存" })}
                >
                  <span className={`${styles.todoIcon} ${styles.blue}`}>
                    <ClockCircleOutlined />
                  </span>
                  <span>
                    <strong>公开留存待验证</strong>
                    <small>当前统计接口未提供汇总</small>
                  </span>
                  <b>—</b>
                  <RightOutlined />
                </button>
                <button type="button" onClick={() => router.push("/campaigns")}>
                  <span className={`${styles.todoIcon} ${styles.slate}`}>
                    <SettingOutlined />
                  </span>
                  <span>
                    <strong>未完整配置规则的活动</strong>
                    <small>活动尚未配置话题规则</small>
                  </span>
                  <b>{incompleteCampaigns}</b>
                  <RightOutlined />
                </button>
              </div>

              <div className={styles.recentTasks}>
                <div className={styles.recentHeader}>
                  <span><CalendarOutlined /> 最近任务</span>
                  <button type="button" onClick={() => router.push("/tasks")}>
                    查看任务
                  </button>
                </div>
                {batches.slice(0, 3).map((batch) => (
                  <button
                    type="button"
                    key={batch.id}
                    className={styles.recentTask}
                    onClick={() => router.push("/tasks")}
                  >
                    <span>
                      <strong>{batch.name || "自动审核任务"}</strong>
                      <small>
                        {new Date(batch.createdAt).toLocaleString("zh-CN", {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </small>
                    </span>
                    <span>{batch.stats.progress}%</span>
                  </button>
                ))}
                {!batches.length ? <span className={styles.noTask}>暂无最近任务</span> : null}
              </div>
            </article>
          </section>
        </>
      )}
    </div>
  );
}
