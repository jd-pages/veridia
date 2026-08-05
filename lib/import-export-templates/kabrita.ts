import type { ImportExportTemplates, StandardField } from "./types";
import { normalizeTemplateHeader } from "./validation";

export const KABRITA_BRAND_NAME = "佳贝艾特" as const;
export const DANONE_BRAND_NAME = "达能" as const;

export const KABRITA_IMPORT_FIELDS = [
  "registrationTime",
  "channel",
  "shopName",
  "customerRemark",
  "buyerPurchaseId",
  "purchaseOrderNumber",
  "purchaseTime",
  "purchaseCanCount",
  "participationCount",
  "xiaohongshuAccount",
  "xiaohongshuPublishLink",
  "purchaseProductLine",
] as const satisfies readonly StandardField[];

export const KABRITA_EXPORT_FIELDS = [
  ...KABRITA_IMPORT_FIELDS,
  "selfReview",
] as const satisfies readonly StandardField[];

// 保留旧名称供历史导入代码读取；它现在只代表佳贝艾特导入字段。
export const KABRITA_TEMPLATE_FIELDS = KABRITA_IMPORT_FIELDS;

export type KabritaTemplateField = (typeof KABRITA_IMPORT_FIELDS)[number];
type KabritaKnownField =
  | KabritaTemplateField
  | "selfReview"
  | "complianceResult";
export type KabritaRawValues = Partial<
  Record<KabritaTemplateField | "complianceResult", string>
>;

export const KABRITA_REQUIRED_FIELDS = [
  "xiaohongshuPublishLink",
  "purchaseProductLine",
] as const satisfies readonly KabritaTemplateField[];

export const KABRITA_FIELD_DEFINITIONS: Record<
  KabritaKnownField,
  ImportExportTemplates["fieldDefinitions"][string]
> = {
  registrationTime: {
    displayName: "登记时间",
    type: "datetime",
    description: "原始登记时间，可留空",
  },
  channel: {
    displayName: "渠道",
    type: "string",
    description: "原始渠道，可留空",
  },
  shopName: {
    displayName: "店铺名称",
    type: "string",
    description: "按店铺话题配置填写完整店铺名称",
  },
  customerRemark: {
    displayName: "客户备注",
    type: "string",
    description: "原始客户备注，可留空",
  },
  buyerPurchaseId: {
    displayName: "买家购买ID",
    type: "string",
    description: "原始买家购买ID，可留空",
  },
  purchaseOrderNumber: {
    displayName: "购买订单号",
    type: "string",
    description: "原始购买订单号，可留空",
  },
  purchaseTime: {
    displayName: "购买时间",
    type: "datetime",
    description: "原始购买时间，可留空",
  },
  purchaseCanCount: {
    displayName: "购买罐数",
    type: "string",
    description: "原始购买罐数，可留空",
  },
  participationCount: {
    displayName: "参与次数",
    type: "string",
    description: "原始参与次数，可留空",
  },
  xiaohongshuAccount: {
    displayName: "发布小红书账号",
    type: "string",
    description: "原始发布账号，可留空",
  },
  xiaohongshuPublishLink: {
    displayName: "小红书发布链接",
    type: "url",
    description: "小红书完整链接、短链或包含链接的文本",
  },
  purchaseProductLine: {
    displayName: "购买产品线",
    type: "string",
    description: "用于匹配佳贝艾特荷兰版或港版产品",
  },
  selfReview: {
    displayName: "自审",
    type: "string",
    description: "系统最终审核结论及具体不通过原因",
  },
  complianceResult: {
    displayName: "是否符合",
    type: "string",
    description: "导入值仅作历史记录，导出使用系统最新审核结论",
  },
};

export const KABRITA_TEMPLATE_EXAMPLES: KabritaRawValues = {
  registrationTime: "2026-08-04 10:00:00",
  channel: "小红书",
  shopName: "佳贝艾特(Kabrita)海外专卖店",
  customerRemark: "",
  buyerPurchaseId: "BUYER-001",
  purchaseOrderNumber: "ORDER-001",
  purchaseTime: "2026-08-03 12:00:00",
  purchaseCanCount: "1",
  participationCount: "1",
  xiaohongshuAccount: "示例账号",
  xiaohongshuPublishLink: "https://xhslink.com/示例短链",
  purchaseProductLine: "荷兰佳贝1",
};

const KABRITA_CORE_HEADERS = [
  "购买产品线",
  "小红书发布链接",
].map(normalizeTemplateHeader);

const KABRITA_ALL_HEADERS = ([...KABRITA_IMPORT_FIELDS, "complianceResult"] as const).map(
  (field) => normalizeTemplateHeader(KABRITA_FIELD_DEFINITIONS[field].displayName),
);

const DANONE_CORE_HEADERS = ["阶段", "阶段（IFFO/GUM）", "产品系列", "产品系列（必填）"]
  .map(normalizeTemplateHeader);

export function isKabritaTemplateHeader(headers: readonly string[]) {
  const normalized = new Set(headers.map(normalizeTemplateHeader));
  const coreMatches = KABRITA_CORE_HEADERS.filter((header) =>
    normalized.has(header),
  ).length;
  const fieldMatches = KABRITA_ALL_HEADERS.filter((header) =>
    normalized.has(header),
  ).length;
  return coreMatches >= 1 && fieldMatches >= 5 &&
    !DANONE_CORE_HEADERS.some((header) => normalized.has(header));
}

export function kabritaFieldDefinition(field: StandardField) {
  return KABRITA_FIELD_DEFINITIONS[field as KabritaTemplateField];
}

export function kabritaDisplayName(field: StandardField) {
  return kabritaFieldDefinition(field)?.displayName || field;
}

export function kabritaRawValues(
  values: Partial<Record<StandardField, string>>,
): KabritaRawValues {
  return Object.fromEntries(
    KABRITA_IMPORT_FIELDS.map((field) => [field, values[field] || ""]),
  ) as KabritaRawValues;
}

export function inferKabritaProductStage(productLine: unknown) {
  const normalized = String(productLine ?? "")
    .normalize("NFKC")
    .replace(/[\s\u00a0\u3000]+/gu, "");
  return /(?:3|三)(?:段)?$/u.test(normalized) ? "GUM" : "IFFO";
}
