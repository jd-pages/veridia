import type { Prisma } from "@prisma/client";
import { processingFailureTaskStatuses } from "@/lib/processing-failure";
import {
  buildResultRiskWhere,
  parseResultRiskType,
} from "@/lib/result-risk";

export interface ResultQueryFilters {
  ids?: string[];
  productId?: string;
  campaignId?: string;
  batchId?: string;
  month?: string;
  startDate?: string;
  endDate?: string;
  dateType?: string;
  status?: string;
  manualStatus?: string;
  imageStatus?: string;
  keyword?: string;
  reason?: string;
  pageStatus?: string;
  bodyStatus?: string;
  topicsStatus?: string;
  clickableStatus?: string;
  noteType?: string;
  ruleVersion?: string;
  publicStatus?: string;
  retentionStatus?: string;
  riskType?: string;
}

export function readResultQueryFilters(
  searchParams: URLSearchParams,
): ResultQueryFilters {
  const value = (key: string) =>
    searchParams.get(key)?.trim() || undefined;
  return {
    ids: value("ids")
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 100),
    productId: value("productId"),
    campaignId: value("campaignId"),
    batchId: value("batchId"),
    month: value("month"),
    startDate: value("startDate"),
    endDate: value("endDate"),
    dateType: value("dateType"),
    status: value("status"),
    manualStatus: value("manualStatus"),
    imageStatus: value("imageStatus"),
    keyword: value("keyword"),
    reason: value("reason"),
    pageStatus: value("pageStatus"),
    bodyStatus: value("bodyStatus"),
    topicsStatus: value("topicsStatus"),
    clickableStatus: value("clickableStatus"),
    noteType: value("noteType"),
    ruleVersion: value("ruleVersion"),
    publicStatus: value("publicStatus"),
    retentionStatus: value("retentionStatus"),
    riskType: value("riskType"),
  };
}

function parseLocalDate(value: string, endOfDay: boolean) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new Error("日期格式必须为 YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0,
  );
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    throw new Error("日期范围包含无效日期");
  }
  return parsed;
}

export function buildLocalDateRange(
  startDate?: string,
  endDate?: string,
) {
  const range: Prisma.DateTimeFilter = {};
  if (startDate) range.gte = parseLocalDate(startDate, false);
  if (endDate) range.lte = parseLocalDate(endDate, true);
  if (
    range.gte instanceof Date &&
    range.lte instanceof Date &&
    range.gte > range.lte
  ) {
    throw new Error("开始日期不能晚于结束日期");
  }
  return range;
}

export function buildAuditResultWhere(
  filters: ResultQueryFilters,
): Prisma.AuditResultWhereInput {
  const and: Prisma.AuditResultWhereInput[] = [];

  if (filters.riskType) {
    const riskType = parseResultRiskType(filters.riskType);
    if (!riskType) throw new Error("风险类型筛选不正确");
    and.push(buildResultRiskWhere(riskType));
  }

  if (filters.ids?.length) {
    and.push({ id: { in: [...new Set(filters.ids)] } });
  }

  const dateRange = buildLocalDateRange(
    filters.startDate,
    filters.endDate,
  );
  if (dateRange.gte || dateRange.lte) {
    const dateType =
      filters.dateType === "CREATED_AT" ? "CREATED_AT" : "AUDITED_AT";
    and.push(
      dateType === "CREATED_AT"
        ? { createdAt: dateRange }
        : { auditedAt: dateRange },
    );
  }

  if (filters.status === "PROCESS_FAILED") {
    and.push({
      task: { status: { in: [...processingFailureTaskStatuses] } },
    });
  } else if (filters.status) {
    and.push({ autoStatus: filters.status });
  }

  if (filters.manualStatus === "PENDING") {
    and.push({
      autoStatus: "NEEDS_REVIEW",
      manualReviews: { none: {} },
    });
  } else if (
    filters.manualStatus === "PASSED" ||
    filters.manualStatus === "FAILED"
  ) {
    and.push({
      manualReviews: { some: { result: filters.manualStatus } },
    });
  } else if (filters.manualStatus === "NOT_REQUIRED") {
    and.push({
      autoStatus: { not: "NEEDS_REVIEW" },
      manualReviews: { none: {} },
    });
  }

  if (filters.imageStatus) {
    and.push({ imageStatus: filters.imageStatus });
  }
  if (filters.pageStatus) and.push({ pageStatus: filters.pageStatus });
  if (filters.bodyStatus) and.push({ bodyStatus: filters.bodyStatus });
  if (filters.topicsStatus) {
    and.push({
      topicsCompliant: filters.topicsStatus === "COMPLIANT",
    });
  }
  if (filters.clickableStatus) {
    and.push({
      clickableCompliant:
        filters.clickableStatus === "COMPLIANT",
    });
  }
  if (filters.noteType) and.push({ noteType: filters.noteType });
  if (filters.ruleVersion) {
    const numericRuleVersion = Number(
      filters.ruleVersion.trim().replace(/^v/iu, ""),
    );
    if (!Number.isInteger(numericRuleVersion) || numericRuleVersion < 1) {
      throw new Error("规则版本格式不正确");
    }
    and.push({ ruleVersion: numericRuleVersion });
  }
  if (filters.publicStatus) {
    and.push({ publicStatus: filters.publicStatus });
  }
  if (filters.retentionStatus) {
    and.push({ retentionStatus: filters.retentionStatus });
  }
  if (filters.reason) {
    and.push({ failureReasons: { contains: filters.reason } });
  }

  if (
    filters.productId ||
    filters.campaignId ||
    filters.batchId ||
    filters.month
  ) {
    and.push({
      task: {
        ...(filters.productId ? { productId: filters.productId } : {}),
        ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
        ...(filters.batchId ? { batchId: filters.batchId } : {}),
        ...(filters.month ? { campaign: { month: filters.month } } : {}),
      },
    });
  }

  if (filters.keyword) {
    and.push({
      OR: [
        { note: { title: { contains: filters.keyword } } },
        { note: { body: { contains: filters.keyword } } },
        { note: { url: { contains: filters.keyword } } },
        { note: { platformNoteId: { contains: filters.keyword } } },
        { task: { finalUrl: { contains: filters.keyword } } },
      ],
    });
  }

  return and.length ? { AND: and } : {};
}
