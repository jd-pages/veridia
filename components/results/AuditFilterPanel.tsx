"use client";

import { Button, DatePicker, Input, Select, Space, Tag } from "antd";
import dayjs from "dayjs";
import {
  DownOutlined,
  ReloadOutlined,
  SearchOutlined,
  UpOutlined,
} from "@ant-design/icons";
import {
  auditResultLabels,
  commonStatusLabels,
} from "@/lib/zh-CN";
import {
  parseResultRiskType,
  resultRiskLabels,
} from "@/lib/result-risk";
import type {
  AdvancedResultFilters,
  CampaignOption,
  ProductOption,
  ResultFilters,
} from "./types";
import styles from "./results-workbench.module.css";

function FilterField({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`${styles.filterField} ${className || ""}`}>
      <label className={styles.fieldLabel}>{label}</label>
      {children}
    </div>
  );
}

export default function AuditFilterPanel({
  filters,
  advancedFilters,
  products,
  campaigns,
  advancedOpen,
  onFiltersChange,
  onAdvancedFiltersChange,
  onAdvancedOpenChange,
  onSearch,
  onReset,
}: {
  filters: ResultFilters;
  advancedFilters: AdvancedResultFilters;
  products: ProductOption[];
  campaigns: CampaignOption[];
  advancedOpen: boolean;
  onFiltersChange: (value: ResultFilters) => void;
  onAdvancedFiltersChange: (value: AdvancedResultFilters) => void;
  onAdvancedOpenChange: (value: boolean) => void;
  onSearch: () => void;
  onReset: () => void;
}) {
  const update = <K extends keyof ResultFilters>(
    key: K,
    value: ResultFilters[K],
  ) => onFiltersChange({ ...filters, [key]: value });
  const updateAdvanced = <K extends keyof AdvancedResultFilters>(
    key: K,
    value: AdvancedResultFilters[K],
  ) => onAdvancedFiltersChange({ ...advancedFilters, [key]: value });
  const activeRiskType = parseResultRiskType(filters.riskType);

  return (
    <section className={styles.panel} aria-label="审核结果筛选">
      <div className={styles.panelHeading}>
        <div>
          <h2 className={styles.panelTitle}>筛选审核结果</h2>
          <div className={styles.panelHint}>
            先使用常用条件定位范围，再按需展开高级筛选
          </div>
        </div>
        {activeRiskType ? (
          <Tag className={styles.activeRiskTag}>
            风险类型：{resultRiskLabels[activeRiskType]}
          </Tag>
        ) : null}
      </div>

      <div className={`${styles.filterGrid} ${styles.primaryFilterGrid}`}>
        <FilterField label="产品">
          <Select
            allowClear
            placeholder="全部产品"
            value={filters.productId || undefined}
            options={products.map((item) => ({
              value: item.id,
              label: item.name,
            }))}
            onChange={(value) =>
              onFiltersChange({
                ...filters,
                productId: value || "",
                campaignId: "",
              })
            }
          />
        </FilterField>
        <FilterField label="活动">
          <Select
            allowClear
            placeholder="全部活动"
            value={filters.campaignId || undefined}
            options={campaigns
              .filter(
                (item) =>
                  !filters.productId || item.productId === filters.productId,
              )
              .map((item) => ({ value: item.id, label: item.name }))}
            onChange={(value) => update("campaignId", value || "")}
          />
        </FilterField>
        <FilterField label="平台">
          <Select
            allowClear
            aria-label="平台"
            placeholder="全部平台"
            value={filters.platform || undefined}
            options={[
              { value: "XIAOHONGSHU", label: "小红书" },
              { value: "DOUYIN", label: "抖音" },
            ]}
            onChange={(value) => update("platform", value || "")}
          />
        </FilterField>
        <FilterField label="日期范围">
          <Space.Compact block className={styles.dateRangeControl}>
            <DatePicker
              allowClear
              inputReadOnly
              aria-label="开始日期"
              placeholder="开始日期"
              format="YYYY-MM-DD"
              value={
                filters.startDate
                  ? dayjs(filters.startDate, "YYYY-MM-DD")
                  : null
              }
              disabledDate={(current) =>
                Boolean(
                  filters.endDate &&
                    current.isAfter(dayjs(filters.endDate), "day"),
                )
              }
              onChange={(value) =>
                update(
                  "startDate",
                  value ? value.format("YYYY-MM-DD") : "",
                )
              }
            />
            <Input
              aria-label="日期范围分隔符"
              value="至"
              readOnly
              style={{
                width: 42,
                textAlign: "center",
                pointerEvents: "none",
              }}
            />
            <DatePicker
              allowClear
              inputReadOnly
              aria-label="结束日期"
              placeholder="结束日期"
              format="YYYY-MM-DD"
              value={
                filters.endDate
                  ? dayjs(filters.endDate, "YYYY-MM-DD")
                  : null
              }
              disabledDate={(current) =>
                Boolean(
                  filters.startDate &&
                    current.isBefore(dayjs(filters.startDate), "day"),
                )
              }
              onChange={(value) =>
                update(
                  "endDate",
                  value ? value.format("YYYY-MM-DD") : "",
                )
              }
            />
          </Space.Compact>
        </FilterField>
      </div>

      <div className={`${styles.filterGrid} ${styles.secondaryFilterGrid}`}>
        <FilterField label="综合审核结果">
          <Select
            allowClear
            placeholder="全部结果"
            value={filters.status || undefined}
            options={[
              { value: "PASSED", label: auditResultLabels.PASSED },
              { value: "FAILED", label: auditResultLabels.FAILED },
              {
                value: "NEEDS_REVIEW",
                label: auditResultLabels.NEEDS_REVIEW,
              },
              { value: "PROCESS_FAILED", label: "处理失败" },
            ]}
            onChange={(value) => update("status", value || "")}
          />
        </FilterField>
        <FilterField label="人工复核状态">
          <Select
            allowClear
            placeholder="全部复核状态"
            value={filters.manualStatus || undefined}
            options={[
              { value: "PENDING", label: "待人工复核" },
              { value: "PASSED", label: "已人工通过" },
              { value: "FAILED", label: "已人工不通过" },
              { value: "NOT_REQUIRED", label: "无需复核" },
            ]}
            onChange={(value) => update("manualStatus", value || "")}
          />
        </FilterField>
        <FilterField label="订单编号">
          <Input
            allowClear
            aria-label="订单编号"
            placeholder="输入完整或部分订单编号"
            value={filters.orderNumber}
            onChange={(event) => update("orderNumber", event.target.value)}
            onBlur={(event) => update("orderNumber", event.target.value.trim())}
            onPressEnter={onSearch}
          />
        </FilterField>
      </div>

      <div className={styles.filterActions}>
        <FilterField label="关键词搜索">
          <Input
            prefix={<SearchOutlined />}
            allowClear
            aria-label="关键词搜索"
            placeholder="笔记链接、标题或正文"
            value={filters.keyword}
            onChange={(event) => update("keyword", event.target.value)}
            onPressEnter={onSearch}
          />
        </FilterField>
        <div className={styles.filterButtonGroup}>
          <Button
            className={styles.advancedToggle}
            icon={advancedOpen ? <UpOutlined /> : <DownOutlined />}
            onClick={() => onAdvancedOpenChange(!advancedOpen)}
          >
            {advancedOpen ? "收起高级筛选" : "高级筛选"}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={onReset}>
            重置
          </Button>
          <Button type="primary" icon={<SearchOutlined />} onClick={onSearch}>
            查询
          </Button>
        </div>
      </div>

      <div
        className={`${styles.advancedPanel} ${
          advancedOpen ? styles.advancedPanelOpen : ""
        }`}
        aria-hidden={!advancedOpen}
      >
        <div className={styles.advancedInner}>
          <div className={styles.advancedGrid}>
            <FilterField label="页面状态">
              <Select
                allowClear
                aria-label="页面状态"
                placeholder="全部页面状态"
                value={advancedFilters.pageStatus || undefined}
                options={[
                  { value: "NORMAL", label: "页面正常" },
                  { value: "READ_FAILED", label: "读取失败" },
                  { value: "NOT_FOUND", label: "页面不存在" },
                  { value: "NO_PERMISSION", label: "不可访问" },
                ]}
                onChange={(value) =>
                  updateAdvanced("pageStatus", value || "")
                }
              />
            </FilterField>
            <FilterField label="正文状态">
              <Select
                allowClear
                placeholder="全部正文状态"
                value={advancedFilters.bodyStatus || undefined}
                options={[
                  { value: "PRESENT", label: "正文存在" },
                  { value: "EMPTY", label: "正文为空" },
                ]}
                onChange={(value) =>
                  updateAdvanced("bodyStatus", value || "")
                }
              />
            </FilterField>
            <FilterField label="话题状态">
              <Select
                allowClear
                placeholder="全部话题状态"
                value={advancedFilters.topicsStatus || undefined}
                options={[
                  { value: "COMPLIANT", label: "话题合规" },
                  { value: "NON_COMPLIANT", label: "话题异常" },
                ]}
                onChange={(value) =>
                  updateAdvanced("topicsStatus", value || "")
                }
              />
            </FilterField>
            <FilterField label="图片数量状态">
              <Select
                allowClear
                placeholder="全部图片状态"
                value={filters.imageStatus || undefined}
                options={[
                  {
                    value: "COMPLIANT",
                    label: commonStatusLabels.COMPLIANT,
                  },
                  {
                    value: "NON_COMPLIANT",
                    label: commonStatusLabels.NON_COMPLIANT,
                  },
                  { value: "VIDEO_NOTE", label: "视频笔记" },
                  {
                    value: "IMAGES_READ_FAILED",
                    label: commonStatusLabels.IMAGES_READ_FAILED,
                  },
                ]}
                onChange={(value) => update("imageStatus", value || "")}
              />
            </FilterField>
            <FilterField label="笔记类型">
              <Select
                allowClear
                placeholder="全部笔记类型"
                value={advancedFilters.noteType || undefined}
                options={[
                  { value: "IMAGE_TEXT", label: "图文笔记" },
                  { value: "VIDEO_NOTE", label: "视频笔记" },
                  { value: "UNKNOWN", label: "未识别" },
                ]}
                onChange={(value) =>
                  updateAdvanced("noteType", value || "")
                }
              />
            </FilterField>
            <FilterField label="公开状态">
              <Select
                allowClear
                placeholder="全部公开状态"
                value={advancedFilters.publicStatus || undefined}
                options={[
                  { value: "PUBLIC", label: "当前公开" },
                  { value: "NOT_PUBLIC", label: "当前不公开" },
                  { value: "UNKNOWN", label: "待确认" },
                ]}
                onChange={(value) =>
                  updateAdvanced("publicStatus", value || "")
                }
              />
            </FilterField>
            <FilterField label="不通过原因" className={styles.advancedReasonField}>
              <Input
                allowClear
                aria-label="不通过原因"
                placeholder="输入原因关键词"
                value={filters.reason}
                onChange={(event) => update("reason", event.target.value)}
                onPressEnter={onSearch}
              />
            </FilterField>
          </div>
        </div>
      </div>
    </section>
  );
}
