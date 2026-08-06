import type { StandardField } from "@/lib/import-export-templates/types";
import {
  normalizeProductStage,
  productStageGroup,
  type CanonicalProductStage,
} from "@/lib/product-stage";

export const IMPORT_TEMPLATE_TYPES = [
  "DANONE_CUSTOMER",
  "DANONE_AGENCY",
  "KABRITA",
] as const;

export type ImportTemplateType = (typeof IMPORT_TEMPLATE_TYPES)[number];

export const IMPORT_TEMPLATE_TYPE_LABELS: Record<ImportTemplateType, string> = {
  DANONE_CUSTOMER: "达能客户",
  DANONE_AGENCY: "达能代发",
  KABRITA: "佳贝艾特",
};

export const DANONE_CUSTOMER_IMPORT_FIELDS = [
  "commercePlatform",
  "shopName",
  "customerName",
  "productName",
  "productStageDetail",
  "productStage",
  "orderNumber",
  "contentChannel",
  "noteUrl",
  "publishTime",
  "activityName",
] as const satisfies readonly StandardField[];

export const DANONE_AGENCY_IMPORT_FIELDS = [
  "commercePlatform",
  "shopName",
  "customerName",
  "productName",
  "productStage",
  "orderNumber",
  "contentChannel",
  "noteUrl",
  "publishTime",
  "activityName",
] as const satisfies readonly StandardField[];

export const DANONE_CUSTOMER_EXPORT_FIELDS = [
  ...DANONE_CUSTOMER_IMPORT_FIELDS,
  "selfReview",
] as const satisfies readonly StandardField[];

export const DANONE_AGENCY_EXPORT_FIELDS = [
  ...DANONE_AGENCY_IMPORT_FIELDS,
  "selfReview",
] as const satisfies readonly StandardField[];

export const DANONE_MIXED_SUMMARY_FIELDS = [
  "templateType",
  "activityMonth",
  "activityName",
  "commercePlatform",
  "shopName",
  "customerName",
  "productName",
  "productStageDetail",
  "productStage",
  "orderNumber",
  "contentChannel",
  "originalUrl",
  "publishTime",
  "selfReview",
] as const satisfies readonly StandardField[];

export function danoneTemplateFieldDisplayName(
  field: StandardField,
  templateType: ImportTemplateType,
  exportMode = false,
) {
  const required = exportMode ? "" : "（必填）";
  const shared: Partial<Record<StandardField, string>> = {
    commercePlatform: `平台${required}`,
    shopName: `店铺名称${required}`,
    customerName: `客户名${required}`,
    productName: `产品系列${required}`,
    productStage: `段位${required}`,
    productStageDetail: `阶段${required}`,
    orderNumber: `订单编号${required}`,
    contentChannel: `内容渠道${required}`,
    noteUrl: `链接${required}`,
    originalUrl: "链接",
    publishTime: `发布时间${required}`,
    activityName: `活动名称${required}`,
    activityMonth: "活动月份",
    templateType: "模板类型",
    selfReview: "自审",
  };
  if (templateType === "DANONE_AGENCY" && field === "productStageDetail") {
    return "阶段";
  }
  return shared[field] || field;
}

export interface InferredAgencyProductStage {
  originalProductName: string;
  normalizedProductName: string;
  inferredStage: CanonicalProductStage | null;
  inferredGroup: "IFFO" | "GUM" | null;
}

export function inferDanoneAgencyProductStage(
  value: unknown,
): InferredAgencyProductStage {
  const originalProductName = String(value ?? "").trim();
  const normalized = originalProductName.normalize("NFKC");
  const match = /(?:PRE|P(?:段)?|[12]\+|[1-4](?:段)?)$/iu.exec(normalized);
  const inferredStage = match ? normalizeProductStage(match[0]) : null;
  return {
    originalProductName,
    normalizedProductName: match
      ? normalized.slice(0, match.index).trim()
      : normalized.trim(),
    inferredStage,
    inferredGroup: inferredStage ? productStageGroup(inferredStage) : null,
  };
}

export function isImportTemplateType(value: unknown): value is ImportTemplateType {
  return IMPORT_TEMPLATE_TYPES.includes(value as ImportTemplateType);
}
