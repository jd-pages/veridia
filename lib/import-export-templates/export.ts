import ExcelJS from "exceljs";
import {
  interactionRewardPresentation,
  type InteractionRewardSnapshot,
} from "@/lib/interaction-reward";
import type { AuditResultPresentation } from "@/lib/audit-result-presentation";
import {
  businessFailureReasonLabel,
  businessSourceLabel,
  businessStatusLabel,
} from "@/lib/zh-CN";
import {
  allowedBodyStageLabels,
  bodyStageRequiredFromRuleSnapshot,
  detectBodyProductStages,
  productStageTopicLabel,
  stageTopicFromRuleSnapshot,
} from "@/lib/product-stage";
import { isUnavailableNoteResult } from "@/lib/result-display";
import {
  resolveResultFinalLink,
  resolveResultOriginalLink,
} from "@/lib/result-links";
import { auditConclusionFailureReasons } from "@/lib/result-detail-presentation";
import {
  commercePlatformLabel,
  contentChannelLabel,
  parseCommercePlatform,
  parseContentChannel,
  resolveTaskChannel,
} from "@/lib/result-source";
import {
  importedPublishTimeValue,
  importedTaskMetadataFromNotes,
  importedTemplateMetadataFromNotes,
} from "@/lib/import-task-metadata";
import { normalizeImportedActivityMonth } from "@/lib/import-activity-matching";
import type {
  ImportExportTemplates,
  ImportTemplateBrand,
  StandardField,
} from "./types";
import { utf8BomCsv } from "./tabular";
import {
  KABRITA_BRAND_NAME,
  KABRITA_EXPORT_FIELDS,
  KABRITA_FIELD_DEFINITIONS,
  KABRITA_IMPORT_FIELDS,
  KABRITA_REQUIRED_FIELDS,
  KABRITA_TEMPLATE_EXAMPLES,
  kabritaFieldDefinition,
} from "./kabrita";
import {
  DANONE_AGENCY_EXPORT_FIELDS,
  DANONE_CUSTOMER_EXPORT_FIELDS,
  DANONE_CUSTOMER_IMPORT_FIELDS,
  IMPORT_TEMPLATE_TYPE_LABELS,
  NESTLE_SHEET_NAME,
  UNIFIED_IMPORT_SHEET_NAMES,
  WYETH_SHEET_NAME,
  danoneTemplateFieldDisplayName,
  type ImportTemplateType,
} from "@/lib/import-template-type";
import {
  WYETH_NESTLE_FIELDS,
  WYETH_NESTLE_FIELD_DEFINITIONS,
  buildWyethNestleProductOptions,
  wyethNestleDisplayName,
  NESTLE_BRAND_NAME,
  WYETH_BRAND_NAME,
} from "./wyeth-nestle";

export type ExportValueRecord = Partial<Record<StandardField, unknown>>;

export const UNIFIED_AUDIT_RESULT_SHEET_NAMES = [
  "达能审核结果",
  "佳贝艾特审核结果",
  "惠氏审核结果",
  "雀巢审核结果",
] as const;

type DownloadableImportTemplateType = Exclude<
  ImportTemplateType,
  "DANONE_AGENCY" | "WYETH_NESTLE"
>;

type WorksheetWithDataValidations = ExcelJS.Worksheet & {
  dataValidations: {
    add(address: string, validation: ExcelJS.DataValidation): void;
  };
};

function addDataValidationRange(
  sheet: ExcelJS.Worksheet,
  columnIndex: number,
  firstRow: number,
  lastRow: number,
  validation: ExcelJS.DataValidation,
) {
  if (columnIndex < 1 || firstRow > lastRow) return;
  const columnLetter = sheet.getColumn(columnIndex).letter;
  (sheet as WorksheetWithDataValidations).dataValidations.add(
    `${columnLetter}${firstRow}:${columnLetter}${lastRow}`,
    validation,
  );
}

export interface CompactAuditResultExportSourceRow extends InteractionRewardSnapshot {
  autoStatus: string;
  pageStatus: string;
  bodyStatus: string;
  topicsCompliant: boolean;
  failureReasons: string;
  ruleSnapshot?: string;
  effectiveBodyLength?: number;
  imageCount?: number;
  imageExtractionStatus: string;
  imageStatus: string;
  publicStatus?: string;
  storeTopicStatus?: string;
  storeTopicFailureReason?: string | null;
  task: {
    url: string;
    originalInput?: string | null;
    normalizedUrl?: string | null;
    finalUrl?: string | null;
    failureCode: string | null;
    failureMessage: string | null;
    pageTitle: string | null;
    pageType: string | null;
    notes: string | null;
    platform?: string | null;
    channel?: string | null;
    commercePlatform?: string | null;
    productStage: string | null;
    product: {
      name: string;
      seriesName?: string | null;
      brandName?: string | null;
    };
    campaign?: { name: string; month?: string | null };
  };
  note: {
    url: string;
    finalUrl: string | null;
    publishedAt: Date | null;
    title: string | null;
    body: string | null;
    topics?: Array<{ displayText: string }>;
  };
  manualReviews: Array<{ result: string; comment?: string | null }>;
  presentation?: AuditResultPresentation;
}

export interface UnreviewedAuditTaskExportSource {
  url: string;
  originalInput?: string | null;
  notes: string | null;
  platform?: string | null;
  channel?: string | null;
  commercePlatform?: string | null;
  productStage?: string | null;
  product: {
    name: string;
    seriesName?: string | null;
    brandName?: string | null;
  };
  campaign?: { name: string; month?: string | null };
}

function importedDateLabel(value: Date) {
  const parts = [
    value.getUTCFullYear(),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0"),
  ];
  const time = [
    String(value.getUTCHours()).padStart(2, "0"),
    String(value.getUTCMinutes()).padStart(2, "0"),
    String(value.getUTCSeconds()).padStart(2, "0"),
  ];
  return `${parts.join("-")} ${time.join(":")}`;
}

function resolvedActivityMonthValue(rawMonth: unknown, campaignMonth: unknown) {
  const rawSource = String(rawMonth ?? "").trim();
  const raw = normalizeImportedActivityMonth(rawSource);
  if (raw) return raw.display;
  const campaignSource = String(campaignMonth ?? "").trim();
  const campaign = normalizeImportedActivityMonth(campaignSource);
  return campaign ? `${campaign.month}月` : rawSource || campaignSource;
}

function hasRawValue(
  raw: Partial<Record<StandardField, string>>,
  field: StandardField,
) {
  return Object.prototype.hasOwnProperty.call(raw, field);
}

function preservedRawValue(
  raw: Partial<Record<StandardField, string>>,
  field: StandardField,
  fallback: unknown,
) {
  return hasRawValue(raw, field) ? raw[field] ?? "" : fallback;
}

function preservedRawLink(
  metadata: ReturnType<typeof importedTemplateMetadataFromNotes>,
  field: "noteUrl" | "xiaohongshuPublishLink",
  fallback: unknown,
) {
  const raw = (metadata?.rawValues || {}) as Partial<Record<StandardField, string>>;
  if (!hasRawValue(raw, field)) return fallback;
  const text = raw[field] ?? "";
  const hyperlink = metadata?.rawHyperlinks?.[field];
  return hyperlink ? { text: text || hyperlink, hyperlink } : text;
}

function exportTextValue(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    "hyperlink" in value &&
    "text" in value
  ) {
    return String(value.text ?? "");
  }
  return value;
}

function columns(
  templates: ImportExportTemplates,
  kind: keyof ImportExportTemplates["columnOrder"],
  templateBrand?: ImportTemplateBrand,
  templateType?: ImportTemplateType,
  fieldsOverride?: readonly StandardField[],
) {
  const auditOutputDisplayNames: Partial<Record<StandardField, string>> = {
    mediaType: "作品类型",
    finalAuditConclusion: "审核结论",
    publicStatus: "公开状态",
    topicsAuditResult: "话题审核",
    imageStatus: "图片 / 视频审核",
    bodyStatus: "正文审核",
    storeTopicAuditResult: "店铺话题审核",
    likeCount: "点赞数",
    commentCount: "评论数",
    favoriteCount: "收藏数",
    interactionTotal: "互动量",
    interactionAtLeastTen: "互动量≥10",
    failedReasons: "失败原因",
    activityMonth: "活动月份",
  };
  if (fieldsOverride) {
    return fieldsOverride.map((field) => ({
      field,
      displayName:
        auditOutputDisplayNames[field] || (field === "templateType"
          ? "模板类型"
          : templateBrand === KABRITA_BRAND_NAME
            ? kabritaFieldDefinition(field)?.displayName || field
          : ["WYETH", "NESTLE", "WYETH_NESTLE"].includes(templateType || "")
            ? wyethNestleDisplayName(field)
            : danoneTemplateFieldDisplayName(
                field,
                templateType || "DANONE_CUSTOMER",
                true,
              )),
    }));
  }
  if (kind === "auditResults" && templateBrand === KABRITA_BRAND_NAME) {
    return KABRITA_EXPORT_FIELDS.map((field) => ({
      field,
      displayName: KABRITA_FIELD_DEFINITIONS[field].displayName,
    }));
  }
  if (kind === "auditResults" && templateType === "DANONE_AGENCY") {
    return DANONE_AGENCY_EXPORT_FIELDS.map((field) => ({
      field,
      displayName: danoneTemplateFieldDisplayName(field, templateType, true),
    }));
  }
  if (kind === "auditResults" && templateType === "DANONE_CUSTOMER") {
    return DANONE_CUSTOMER_EXPORT_FIELDS.map((field) => ({
      field,
      displayName: danoneTemplateFieldDisplayName(field, templateType, true),
    }));
  }
  const auditResultDisplayNames: Partial<Record<StandardField, string>> = {
    commercePlatform: "平台",
    shopName: "店铺名称",
    customerName: "客户名",
    productName: "产品系列",
    productStageTopic: "阶段",
    orderNumber: "订单编号",
    contentChannel: "内容渠道",
    originalUrl: "链接",
    publishTime: "发帖时间",
    activityName: "活动名称",
    selfReview: "自审",
  };
  return templates.columnOrder[kind].map((field) => ({
    field,
    displayName:
      kind === "auditResults" && auditResultDisplayNames[field]
        ? auditResultDisplayNames[field]!
        : templates.fieldDefinitions[field].displayName,
  }));
}

const REWARD_COLUMNS = [
  { field: "likeCount", displayName: "点赞数" },
  { field: "commentCount", displayName: "评论数" },
  { field: "favoriteCount", displayName: "收藏数" },
  { field: "interactionTotal", displayName: "互动合计" },
  { field: "interactionRewardThreshold", displayName: "互动奖励门槛" },
  { field: "interactionRewardStatus", displayName: "互动奖励结果" },
] satisfies Array<{ field: StandardField; displayName: string }>;

function appendRewardColumns(selected: Array<{ field: StandardField; displayName: string }>, records: ExportValueRecord[]) {
  if (records.some((record) => Boolean(record.interactionRewardStatus))) {
    for (const column of REWARD_COLUMNS) {
      if (!selected.some((existing) => existing.field === column.field)) selected.push(column);
    }
  }
}

function rewardExport(row: InteractionRewardSnapshot) {
  const reward = interactionRewardPresentation(row);
  return {
    likeCount: row.likeCount ?? null, commentCount: row.commentCount ?? null,
    favoriteCount: row.favoriteCount ?? null, interactionTotal: row.interactionTotal ?? null,
    interactionRewardThreshold: row.interactionRewardThreshold ?? null,
    interactionRewardStatus: reward?.status || null,
  };
}

function safeInteractionCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function businessInteractionExport(
  row: InteractionRewardSnapshot & { pageStatus: string },
) {
  if (row.pageStatus !== "NORMAL") {
    return {
      likeCount: null,
      commentCount: null,
      favoriteCount: null,
      interactionTotal: null,
      interactionAtLeastTen: "",
    };
  }
  const rawLikeCount = safeInteractionCount(row.likeCount);
  const rawCommentCount = safeInteractionCount(row.commentCount);
  const rawFavoriteCount = safeInteractionCount(row.favoriteCount);
  const likeCount = rawLikeCount ?? 0;
  const commentCount = rawCommentCount ?? 0;
  const favoriteCount = rawFavoriteCount ?? 0;
  const interactionTotal = likeCount + commentCount + favoriteCount;
  return {
    likeCount,
    commentCount,
    favoriteCount,
    interactionTotal,
    interactionAtLeastTen: interactionTotal >= 10 ? "Y" : "N",
  };
}

function topicExportValue(presentation: AuditResultPresentation) {
  const topic = presentation.topic;
  if (topic.status === "UNAVAILABLE") return topic.message || "历史审核明细不可用";
  if (topic.status === "NEEDS_REVIEW") return "待人工复核";
  const summary = `${topic.matchedCount}/${topic.expectedCount} ${topic.status === "COMPLIANT" ? "合规" : "不合规"}`;
  return topic.missing.length ? `${summary}，缺少 ${topic.missing.join("、")}` : summary;
}

function imageExportValue(presentation: AuditResultPresentation) {
  if (presentation.media.kind === "VIDEO") return "视频作品，不参与图片数量审核";
  if (presentation.media.kind === "UNKNOWN") return "无法确认";
  const count = presentation.media.imageCount;
  if (count === null) return "无法确认";
  if (presentation.image.status === "NON_COMPLIANT" && presentation.image.minimumCount !== null) {
    return `${count}张，数量不足，要求至少${presentation.image.minimumCount}张`;
  }
  return `${count}张，${presentation.image.label}`;
}

function bodyExportValue(row: CompactAuditResultExportSourceRow) {
  const body = row.presentation?.body;
  if (!body) return "待人工确认";
  const length = typeof row.effectiveBodyLength === "number" ? row.effectiveBodyLength : null;
  return `${body.label}${length === null ? "" : `，${length}字符`}`;
}

function storeTopicExportValue(row: CompactAuditResultExportSourceRow) {
  if (!row.presentation?.storeTopic.applicable) return "不适用";
  const status = row.presentation.storeTopic.status;
  if (status === "COMPLIANT") return "合规";
  if (status === "NON_COMPLIANT") {
    return `不合规${row.storeTopicFailureReason ? `：${row.storeTopicFailureReason}` : ""}`;
  }
  if (status === "NOT_REQUIRED") return "不要求";
  return "待人工复核";
}

function completeAuditExport(row: CompactAuditResultExportSourceRow): ExportValueRecord {
  const presentation = row.presentation;
  const interaction = businessInteractionExport(row);
  const brand = row.task.product.brandName?.trim() || "";
  const thresholdApplicable = new Set<string>([
    WYETH_BRAND_NAME,
    NESTLE_BRAND_NAME,
    KABRITA_BRAND_NAME,
  ]).has(brand);
  const interactionAtLeastTen = !thresholdApplicable
    ? "不适用"
    : interaction.interactionAtLeastTen;
  return {
    mediaType: presentation?.media.kind === "VIDEO"
      ? "视频"
      : presentation?.media.kind === "IMAGE_TEXT" ? "图文" : "无法确认",
    finalAuditConclusion: presentation?.conclusion.label || "待人工复核",
    publicStatus: presentation?.publicDisplay.label || "无法确认",
    topicsAuditResult: presentation ? topicExportValue(presentation) : "历史审核明细不可用",
    imageStatus: presentation ? imageExportValue(presentation) : "无法确认",
    bodyStatus: bodyExportValue(row),
    storeTopicAuditResult: storeTopicExportValue(row),
    ...interaction,
    interactionAtLeastTen,
    failedReasons: presentation?.failureReasons.join("；") || "",
  };
}

function unreviewedAuditExport(): ExportValueRecord {
  return {
    mediaType: "未审核",
    finalAuditConclusion: "未审核",
    publicStatus: "未审核",
    topicsAuditResult: "未审核",
    imageStatus: "未审核",
    bodyStatus: "未审核",
    storeTopicAuditResult: "未审核",
    likeCount: null,
    commentCount: null,
    favoriteCount: null,
    interactionTotal: null,
    interactionAtLeastTen: "未审核",
    failedReasons: "",
  };
}

function fieldDefinition(
  templates: ImportExportTemplates,
  field: StandardField,
  templateBrand?: ImportTemplateBrand,
) {
  return templateBrand === KABRITA_BRAND_NAME
    ? kabritaFieldDefinition(field) || templates.fieldDefinitions[field]
    : templates.fieldDefinitions[field];
}

function list(value: string, separator: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.map(String).map(businessFailureReasonLabel).join(separator)
      : String(value || "");
  } catch {
    return String(value || "");
  }
}

function compactSelfReview(row: CompactAuditResultExportSourceRow) {
  if (
    row.presentation?.consistency.status ===
    "RESULT_CONSISTENCY_VIOLATION"
  ) {
    return "N-结果一致性异常";
  }
  const manual = row.manualReviews[0];
  if (manual?.result === "PASSED") return "Y";
  if (manual?.result === "FAILED") {
    const reason = manual.comment?.trim();
    return reason ? `N-人工不通过；${reason}` : "N-人工不通过";
  }
  const finalStatus = row.presentation?.conclusion.status || row.autoStatus;
  if (finalStatus === "PASSED") return "Y";

  const unavailable = isUnavailableNoteResult({
    pageStatus: row.pageStatus,
    failureReasons: row.failureReasons,
    pageTitle: row.task.pageTitle,
    note: { title: row.note.title, body: row.note.body },
    task: {
      failureCode: row.task.failureCode,
      failureMessage: row.task.failureMessage,
      pageTitle: row.task.pageTitle,
      pageType: row.task.pageType,
    },
  });
  const importedMetadata = importedTaskMetadataFromNotes(row.task.notes);
  const failureReasonList = row.presentation?.failureReasons.join(" ") ||
    list(row.failureReasons, " ");
  const evidence = [
    row.pageStatus,
    row.bodyStatus,
    row.imageExtractionStatus,
    row.imageStatus,
    row.task.failureCode,
    row.task.failureMessage,
    row.failureReasons,
    failureReasonList,
    importedMetadata.contentChannel,
  ]
    .filter(Boolean)
    .join(" ");

  if (
    unavailable ||
    row.pageStatus === "NO_PERMISSION" ||
    /PAGE_NOT_FOUND|PAGE_UNAVAILABLE|NOT_ACCESSIBLE|HTTP[_ -]?404|\b404\b|页面(?:无法访问|不见了|不存在)|笔记不存在|无法浏览|链接失效|该内容无法查看/iu.test(
      evidence,
    )
  ) {
    return "N-帖子无法查看";
  }
  if (
    /CONTENT_CHANNEL_UNSUPPORTED|UNSUPPORTED_CONTENT_CHANNEL|内容渠道.{0,8}(?:不支持|暂不支持)|(?:不支持|暂不支持).{0,8}内容渠道|快手/iu.test(
      evidence,
    )
  ) {
    return "N-内容渠道不支持";
  }
  if (finalStatus !== "FAILED") return "待人工复核";
  if (
    row.topicsCompliant === false ||
    /TOPIC(?:S)?_(?:MISSING|NOT_MATCHED|NON_COMPLIANT)|缺少.{0,8}话题|话题.{0,8}(?:未命中|不合规|缺失)|阶段话题.{0,8}缺失|未识别到话题|缺少精确话题/iu.test(
      evidence,
    )
  ) {
    return "N-缺少话题";
  }
  if (
    row.bodyStatus === "EMPTY" ||
    /BODY_(?:EMPTY|MISSING|TOO_SHORT)|正文.{0,8}(?:不存在|为空|过短)|有效正文字数不足|字数.{0,8}(?:不足|不达标|不够)/iu.test(
      evidence,
    )
  ) {
    return "N-字数不够";
  }
  if (
    row.imageStatus === "NON_COMPLIANT" ||
    /IMAGE_COUNT_(?:INSUFFICIENT|INVALID)|图片(?:数量)?.{0,8}(?:不足|不达标|不合规)|图片不足/iu.test(
      evidence,
    )
  ) {
    return "N-图片不足";
  }
  if (
    /BODY_STAGE_(?:MISMATCH|INVALID)|阶段.{0,8}(?:不匹配|不符)|段位.{0,8}(?:不属于|不匹配|不符)|IFFO.{0,12}GUM.{0,8}(?:不符|不匹配)|正文段位不属于|正文未出现对应段位/iu.test(
      evidence,
    )
  ) {
    return "N-阶段不符";
  }
  return "N-其他不合规";
}

export function detailedSelfReview(row: CompactAuditResultExportSourceRow) {
  const summary = compactSelfReview(row);
  if (!summary || summary === "Y") return summary;
  let details = (row.presentation?.failureReasons ||
    auditConclusionFailureReasons(row)).filter(
    (reason) =>
      !/^(?:话题缺少|缺少话题|缺少指定话题|话题未命中|字数不足|图片不足|阶段不符|不合规|审核失败)$/u.test(
        reason,
      ),
  );
  if (summary === "N-帖子无法查看") {
    details = details.map((reason) =>
      reason.startsWith("页面无法访问：")
        ? reason
        : `页面无法访问：${reason}`,
    );
  }
  return details.length ? `${summary}；${details.join("；")}` : summary;
}

function wyethNestleSelfReview(row: CompactAuditResultExportSourceRow) {
  const presentation = row.presentation;
  const interactionOnlyReview =
    !row.manualReviews.length &&
    row.autoStatus === "PASSED" &&
    presentation?.consistency.status === "CONSISTENT" &&
    presentation.conclusion.status === "NEEDS_REVIEW" &&
    presentation.reviewReasons.length > 0 &&
    presentation.reviewReasons.every((reason) => reason === "互动奖励待确认");
  return interactionOnlyReview ? "Y" : detailedSelfReview(row);
}

/**
 * 审核结果下载只读取业务模板实际需要的数据。
 * 历史结果中的规则快照或技术审核字段即使不完整，也不应阻断人工导出。
 */
export function auditResultToCompactExportRecord(
  row: CompactAuditResultExportSourceRow,
): ExportValueRecord {
  const importedMetadata = importedTaskMetadataFromNotes(row.task.notes);
  const templateMetadata = importedTemplateMetadataFromNotes(row.task.notes);
  const raw = (templateMetadata?.rawValues || {}) as Partial<
    Record<StandardField, string>
  >;
  const templateType =
    templateMetadata?.templateType === "DANONE_AGENCY"
      ? "DANONE_AGENCY"
      : "DANONE_CUSTOMER";
  const commercePlatform =
    parseCommercePlatform(row.task.commercePlatform) ||
    parseCommercePlatform(importedMetadata.platform);
  const channel =
    resolveTaskChannel(row.task) ||
    parseContentChannel(importedMetadata.contentChannel);
  return {
    commercePlatform: preservedRawValue(
      raw,
      "commercePlatform",
      preservedRawValue(raw, "platform", commercePlatformLabel(commercePlatform)),
    ),
    shopName: preservedRawValue(raw, "shopName", importedMetadata.shopName),
    customerName: preservedRawValue(raw, "customerName", importedMetadata.customerName),
    productName: preservedRawValue(
      raw,
      "productName",
      row.task.product.seriesName || row.task.product.name,
    ),
    productStage: preservedRawValue(
      raw,
      "productStage",
      row.task.productStage?.startsWith("GUM") ? "GUM" : "IFFO",
    ),
    productStageDetail:
      templateType === "DANONE_CUSTOMER"
        ? preservedRawValue(raw, "productStageDetail", "")
        : "",
    productStageTopic: productStageTopicLabel(row.task.productStage),
    orderNumber: preservedRawValue(raw, "orderNumber", importedMetadata.orderNumber),
    contentChannel: preservedRawValue(
      raw,
      "contentChannel",
      contentChannelLabel(channel),
    ),
    noteUrl: preservedRawLink(templateMetadata, "noteUrl", resolveResultOriginalLink(row)),
    originalUrl: resolveResultOriginalLink(row),
    publishTime: hasRawValue(raw, "publishTime")
      ? raw.publishTime ?? ""
      : importedMetadata.publishTime
        ? importedPublishTimeValue(importedMetadata.publishTime)
        : row.note.publishedAt,
    activityName: preservedRawValue(
      raw,
      "activityName",
      importedMetadata.activityName || row.task.campaign?.name || "",
    ),
    activityMonth: hasRawValue(raw, "activityMonth")
      ? raw.activityMonth ?? ""
      : resolvedActivityMonthValue(undefined, row.task.campaign?.month),
    templateType: IMPORT_TEMPLATE_TYPE_LABELS[templateType],
    selfReview: detailedSelfReview(row),
    ...rewardExport(row),
    ...completeAuditExport(row),
  };
}

export function auditTaskToUnreviewedCompactExportRecord(
  task: UnreviewedAuditTaskExportSource,
): ExportValueRecord {
  const importedMetadata = importedTaskMetadataFromNotes(task.notes);
  const templateMetadata = importedTemplateMetadataFromNotes(task.notes);
  const raw = (templateMetadata?.rawValues || {}) as Partial<
    Record<StandardField, string>
  >;
  const templateType = templateMetadata?.templateType === "DANONE_AGENCY"
    ? "DANONE_AGENCY"
    : "DANONE_CUSTOMER";
  const commercePlatform = parseCommercePlatform(task.commercePlatform) ||
    parseCommercePlatform(importedMetadata.platform);
  const channel = resolveTaskChannel(task) ||
    parseContentChannel(importedMetadata.contentChannel);
  return {
    commercePlatform: preservedRawValue(
      raw,
      "commercePlatform",
      preservedRawValue(raw, "platform", commercePlatformLabel(commercePlatform)),
    ),
    shopName: preservedRawValue(raw, "shopName", importedMetadata.shopName),
    customerName: preservedRawValue(raw, "customerName", importedMetadata.customerName),
    productName: preservedRawValue(
      raw,
      "productName",
      task.product.seriesName || task.product.name,
    ),
    productStage: preservedRawValue(
      raw,
      "productStage",
      task.productStage?.startsWith("GUM") ? "GUM" : "IFFO",
    ),
    productStageDetail: templateType === "DANONE_CUSTOMER"
      ? preservedRawValue(raw, "productStageDetail", "")
      : "",
    productStageTopic: productStageTopicLabel(task.productStage),
    orderNumber: preservedRawValue(raw, "orderNumber", importedMetadata.orderNumber),
    contentChannel: preservedRawValue(raw, "contentChannel", contentChannelLabel(channel)),
    noteUrl: preservedRawLink(templateMetadata, "noteUrl", task.originalInput || task.url),
    originalUrl: task.originalInput || task.url,
    publishTime: hasRawValue(raw, "publishTime")
      ? raw.publishTime ?? ""
      : importedMetadata.publishTime
        ? importedPublishTimeValue(importedMetadata.publishTime)
        : "",
    activityName: preservedRawValue(
      raw,
      "activityName",
      importedMetadata.activityName || task.campaign?.name || "",
    ),
    activityMonth: hasRawValue(raw, "activityMonth")
      ? raw.activityMonth ?? ""
      : resolvedActivityMonthValue(undefined, task.campaign?.month),
    templateType: IMPORT_TEMPLATE_TYPE_LABELS[templateType],
    selfReview: "未审核",
    ...unreviewedAuditExport(),
  };
}

export function auditResultToKabritaExportRecord(
  row: CompactAuditResultExportSourceRow,
): ExportValueRecord {
  const templateMetadata = importedTemplateMetadataFromNotes(row.task.notes);
  const raw = templateMetadata?.rawValues || {};
  const imported = importedTaskMetadataFromNotes(row.task.notes);
  return {
    registrationTime: preservedRawValue(raw, "registrationTime", ""),
    channel: preservedRawValue(raw, "channel", ""),
    shopName: preservedRawValue(raw, "shopName", imported.shopName),
    customerRemark: preservedRawValue(raw, "customerRemark", ""),
    buyerPurchaseId: preservedRawValue(raw, "buyerPurchaseId", ""),
    purchaseOrderNumber:
      preservedRawValue(raw, "purchaseOrderNumber", imported.orderNumber),
    purchaseTime: preservedRawValue(raw, "purchaseTime", ""),
    purchaseCanCount: preservedRawValue(raw, "purchaseCanCount", ""),
    participationCount: preservedRawValue(raw, "participationCount", ""),
    xiaohongshuAccount: preservedRawValue(raw, "xiaohongshuAccount", ""),
    xiaohongshuPublishLink: preservedRawLink(
      templateMetadata,
      "xiaohongshuPublishLink",
      resolveResultOriginalLink(row),
    ),
    purchaseProductLine: preservedRawValue(
      raw,
      "purchaseProductLine",
      row.task.product.seriesName || row.task.product.name,
    ),
    activityMonth: hasRawValue(raw, "activityMonth")
      ? raw.activityMonth ?? ""
      : resolvedActivityMonthValue(undefined, row.task.campaign?.month),
    complianceResult: kabritaComplianceResult(row),
    ...rewardExport(row),
    ...completeAuditExport(row),
  };
}

export function auditTaskToUnreviewedKabritaExportRecord(
  task: UnreviewedAuditTaskExportSource,
): ExportValueRecord {
  const templateMetadata = importedTemplateMetadataFromNotes(task.notes);
  const raw = templateMetadata?.rawValues || {};
  const imported = importedTaskMetadataFromNotes(task.notes);
  return {
    registrationTime: preservedRawValue(raw, "registrationTime", ""),
    channel: preservedRawValue(raw, "channel", ""),
    shopName: preservedRawValue(raw, "shopName", imported.shopName),
    customerRemark: preservedRawValue(raw, "customerRemark", ""),
    buyerPurchaseId: preservedRawValue(raw, "buyerPurchaseId", ""),
    purchaseOrderNumber: preservedRawValue(raw, "purchaseOrderNumber", imported.orderNumber),
    purchaseTime: preservedRawValue(raw, "purchaseTime", ""),
    purchaseCanCount: preservedRawValue(raw, "purchaseCanCount", ""),
    participationCount: preservedRawValue(raw, "participationCount", ""),
    xiaohongshuAccount: preservedRawValue(raw, "xiaohongshuAccount", ""),
    xiaohongshuPublishLink: preservedRawLink(
      templateMetadata,
      "xiaohongshuPublishLink",
      task.originalInput || task.url,
    ),
    purchaseProductLine: preservedRawValue(
      raw,
      "purchaseProductLine",
      task.product.seriesName || task.product.name,
    ),
    complianceResult: "未审核",
    activityMonth: hasRawValue(raw, "activityMonth")
      ? raw.activityMonth ?? ""
      : resolvedActivityMonthValue(undefined, task.campaign?.month),
    ...unreviewedAuditExport(),
  };
}

export function kabritaComplianceResult(
  row: CompactAuditResultExportSourceRow,
) {
  let base = detailedSelfReview(row);
  if (!row.manualReviews.length) {
    let reasons: string[] = [];
    try {
      const parsed = JSON.parse(row.failureReasons) as unknown;
      reasons = Array.isArray(parsed) ? parsed.map(String) : [String(parsed || "")];
    } catch {
      reasons = row.failureReasons ? [row.failureReasons] : [];
    }
    const interactionReasons = reasons.filter((reason) =>
      /基础奖励(?:未达成|互动数据无法确认)|互动合计/iu.test(reason),
    );
    const otherReasons = reasons.filter((reason) =>
      !/基础奖励(?:未达成|互动数据无法确认)|互动合计/iu.test(reason),
    );
    if (interactionReasons.length) {
      const contentStatus = otherReasons.length ? row.autoStatus : "PASSED";
      const contentPresentation = row.presentation &&
        row.presentation.consistency.status === "CONSISTENT"
        ? {
            ...row.presentation,
            automaticConclusion: {
              ...row.presentation.automaticConclusion,
              status: contentStatus,
              label: contentStatus === "PASSED" ? "审核通过" : row.presentation.automaticConclusion.label,
              tone: contentStatus === "PASSED" ? "success" as const : row.presentation.automaticConclusion.tone,
            },
            conclusion: {
              ...row.presentation.conclusion,
              status: contentStatus,
              label: contentStatus === "PASSED" ? "审核通过" : row.presentation.conclusion.label,
              tone: contentStatus === "PASSED" ? "success" as const : row.presentation.conclusion.tone,
            },
            failureReasons: row.presentation.failureReasons.filter((reason) =>
              !/基础奖励(?:未达成|互动数据无法确认)|互动合计/iu.test(reason),
            ),
          }
        : row.presentation;
      base = detailedSelfReview({
        ...row,
        autoStatus: contentStatus,
        failureReasons: JSON.stringify(otherReasons),
        presentation: contentPresentation,
      });
    }
  }
  const interaction = businessInteractionExport(row).interactionAtLeastTen;
  if (!interaction) return base;
  if (base === "Y") return interaction === "Y" ? "Y" : "N-互动量＜10";
  if (interaction === "Y" || base.includes("互动量＜10")) return base;
  return [base, "N-互动量＜10"].filter(Boolean).join("；");
}

export function auditResultToWyethNestleExportRecord(
  row: CompactAuditResultExportSourceRow,
): ExportValueRecord {
  const imported = importedTaskMetadataFromNotes(row.task.notes);
  const templateMetadata = importedTemplateMetadataFromNotes(row.task.notes);
  const raw = (templateMetadata?.rawValues || {}) as Partial<
    Record<StandardField, string>
  >;
  const commercePlatform =
    parseCommercePlatform(row.task.commercePlatform) ||
    parseCommercePlatform(imported.platform);
  const channel =
    resolveTaskChannel(row.task) ||
    parseContentChannel(imported.contentChannel);
  return {
    registrant: preservedRawValue(raw, "registrant", ""),
    wechatNickname: preservedRawValue(raw, "wechatNickname", imported.customerName),
    commercePlatform: preservedRawValue(
      raw,
      "commercePlatform",
      commercePlatformLabel(commercePlatform),
    ),
    shopName: preservedRawValue(raw, "shopName", imported.shopName),
    productName: preservedRawValue(
      raw,
      "productName",
      row.task.product.seriesName || row.task.product.name,
    ),
    orderNumber: preservedRawValue(raw, "orderNumber", imported.orderNumber),
    contentChannel: preservedRawValue(
      raw,
      "contentChannel",
      contentChannelLabel(channel),
    ),
    noteUrl: preservedRawLink(templateMetadata, "noteUrl", resolveResultOriginalLink(row)),
    publishTime: hasRawValue(raw, "publishTime")
      ? raw.publishTime ?? ""
      : row.note.publishedAt,
    activityMonth: hasRawValue(raw, "activityMonth")
      ? raw.activityMonth ?? ""
      : resolvedActivityMonthValue(undefined, row.task.campaign?.month),
    customerServiceComment: preservedRawValue(raw, "customerServiceComment", ""),
    selfReview: wyethNestleSelfReview(row),
    ...completeAuditExport(row),
  };
}

export function auditTaskToUnreviewedWyethNestleExportRecord(
  task: UnreviewedAuditTaskExportSource,
): ExportValueRecord {
  const imported = importedTaskMetadataFromNotes(task.notes);
  const templateMetadata = importedTemplateMetadataFromNotes(task.notes);
  const raw = (templateMetadata?.rawValues || {}) as Partial<
    Record<StandardField, string>
  >;
  const commercePlatform = parseCommercePlatform(task.commercePlatform) ||
    parseCommercePlatform(imported.platform);
  const channel = resolveTaskChannel(task) ||
    parseContentChannel(imported.contentChannel);
  return {
    registrant: preservedRawValue(raw, "registrant", ""),
    wechatNickname: preservedRawValue(raw, "wechatNickname", imported.customerName),
    commercePlatform: preservedRawValue(
      raw,
      "commercePlatform",
      commercePlatformLabel(commercePlatform),
    ),
    shopName: preservedRawValue(raw, "shopName", imported.shopName),
    productName: preservedRawValue(
      raw,
      "productName",
      task.product.seriesName || task.product.name,
    ),
    orderNumber: preservedRawValue(raw, "orderNumber", imported.orderNumber),
    contentChannel: preservedRawValue(raw, "contentChannel", contentChannelLabel(channel)),
    noteUrl: preservedRawLink(templateMetadata, "noteUrl", task.originalInput || task.url),
    publishTime: hasRawValue(raw, "publishTime") ? raw.publishTime ?? "" : "",
    customerServiceComment: preservedRawValue(raw, "customerServiceComment", ""),
    selfReview: "未审核",
    interactionAtLeastTen: "未审核",
    activityMonth: hasRawValue(raw, "activityMonth")
      ? raw.activityMonth ?? ""
      : resolvedActivityMonthValue(undefined, task.campaign?.month),
    ...unreviewedAuditExport(),
  };
}

export function auditResultToExportRecord(row: InteractionRewardSnapshot & {
  autoStatus: string;
  pageStatus: string;
  bodyStatus: string;
  topicsCompliant: boolean;
  failureReasons: string;
  ruleVersion: number;
  rulePackageVersion: string | null;
  ruleSnapshot: string;
  createdAt: Date;
  auditedAt: Date;
  effectiveBodyLength: number;
  imageCount: number;
  imageExtractionStatus: string;
  imageStatus: string;
  publicStatus: string;
  task: {
    url: string;
    originalInput?: string | null;
    normalizedUrl?: string | null;
    finalUrl: string | null;
    status: string;
    source: string;
    attempts: number;
    failureCode: string | null;
    failureMessage: string | null;
    pageTitle: string | null;
    pageType: string | null;
    createdAt: Date;
    productStage: string | null;
    notes: string | null;
    platform?: string | null;
    channel?: string | null;
    commercePlatform?: string | null;
    product: { name: string; seriesName?: string | null };
    campaign: { name: string };
  };
  note: {
    url: string;
    finalUrl: string | null;
    platformNoteId: string | null;
    authorName: string | null;
    publishedAt: Date | null;
    title: string | null;
    body: string | null;
    topics: Array<{ displayText: string }>;
  };
  ruleResults: Array<{ ruleName: string; passed: boolean }>;
  manualReviews: Array<{
    result: string;
    comment: string | null;
    createdAt: Date;
    reviewer?: { displayName: string } | null;
  }>;
  presentation?: AuditResultPresentation;
}, templates: ImportExportTemplates, options?: {
  dateType?: string;
}): ExportValueRecord {
  const separator =
    templates.exportTemplates.auditResults?.multiValueSeparator || "、";
  const manual = row.manualReviews[0];
  const requiresManualReview = row.presentation
    ? row.presentation.isManualReviewRequired
    : row.autoStatus === "NEEDS_REVIEW" ||
      ["FAILED", "READ_FAILED", "LOGIN_EXPIRED"].includes(row.task.status);
  const manualReviewStatus = manual
    ? manual.result === "PASSED"
      ? "已人工通过"
      : "已人工不通过"
    : requiresManualReview
      ? "待人工复核"
      : "无需复核";
  const bodyStageRequired =
    bodyStageRequiredFromRuleSnapshot(row.ruleSnapshot) ||
    row.ruleResults.some((rule) => /正文段位/u.test(rule.ruleName));
  const bodyStage = bodyStageRequired
    ? detectBodyProductStages(
        row.note.body,
        row.task.productStage,
      )
    : null;
  const failureReasonList = row.presentation
    ? row.presentation.failureReasons.join(separator)
    : list(row.failureReasons, separator);
  const detailedFailureReasonList = (row.presentation?.failureReasons ||
    auditConclusionFailureReasons(row)).join(
    separator,
  );
  const autoAuditResult = row.presentation?.automaticConclusion.label ||
    businessStatusLabel(row.autoStatus, "audit");
  const manualAuditResult = manual
    ? businessStatusLabel(manual.result, "audit")
    : "";
  const finalAuditConclusion = row.presentation?.conclusion.label ||
    manualAuditResult || autoAuditResult;
  const unavailable = isUnavailableNoteResult({
    pageStatus: row.pageStatus,
    failureReasons: row.failureReasons,
    pageTitle: row.task.pageTitle,
    note: { title: row.note.title, body: row.note.body },
    task: {
      failureCode: row.task.failureCode,
      failureMessage: row.task.failureMessage,
      pageTitle: row.task.pageTitle,
      pageType: row.task.pageType,
    },
  });
  const selfReview = compactSelfReview(row);
  const importedMetadata = importedTaskMetadataFromNotes(row.task.notes);
  const commercePlatform =
    parseCommercePlatform(row.task.commercePlatform) ||
    parseCommercePlatform(importedMetadata.platform);
  const channel =
    resolveTaskChannel(row.task) ||
    parseContentChannel(importedMetadata.contentChannel);
  const bodyStatus =
    row.bodyStatus === "PRESENT"
      ? "正文存在"
      : row.bodyStatus === "EMPTY"
        ? "正文为空"
        : "未提取到正文 / 待人工确认";
  return {
    noteUrl: resolveResultOriginalLink(row),
    originalUrl: resolveResultOriginalLink(row),
    finalUrl: resolveResultFinalLink(row),
    noteId: row.note.platformNoteId,
    commercePlatform: commercePlatformLabel(commercePlatform),
    shopName: importedMetadata.shopName,
    customerName: importedMetadata.customerName,
    productName: row.task.product.seriesName || row.task.product.name,
    orderNumber: importedMetadata.orderNumber,
    contentChannel: contentChannelLabel(channel),
    activityName: importedMetadata.activityName || row.task.campaign.name,
    source: businessSourceLabel(row.task.source),
    productStageTopic: productStageTopicLabel(row.task.productStage),
    allowedBodyStages: bodyStageRequired
      ? allowedBodyStageLabels(row.task.productStage).join(separator)
      : "不要求正文出现段位词",
    detectedBodyStages:
      bodyStageRequired
        ? bodyStage?.detectedStages.join(separator) || "段位未识别"
        : "不参与审核",
    requiredStageTopic: stageTopicFromRuleSnapshot(row.ruleSnapshot) || "",
    influencerName: row.note.authorName,
    publishTime: importedMetadata.publishTime
      ? importedPublishTimeValue(importedMetadata.publishTime)
      : row.note.publishedAt,
    title: row.note.title,
    content: row.note.body,
    effectiveBodyLength: row.effectiveBodyLength,
    ...rewardExport(row),
    imageCount: row.imageCount,
    imageExtractionStatus: businessStatusLabel(
      row.imageExtractionStatus,
    ),
    imageStatus: unavailable
      ? "无"
      : `${row.imageCount}张，${businessStatusLabel(row.imageStatus)}`,
    topicTags: row.note.topics
      .map((topic) => topic.displayText)
      .join(separator),
    pageStatus: unavailable
      ? "笔记不存在"
      : businessStatusLabel(row.pageStatus),
    bodyStatus,
    topicsAuditResult: unavailable
      ? "无"
      : row.topicsCompliant
        ? "合规"
        : "不合规",
    publicStatus: businessStatusLabel(row.publicStatus),
    auditStatus: businessStatusLabel(row.task.status, "process"),
    auditResult: finalAuditConclusion,
    autoAuditResult,
    manualAuditResult,
    finalAuditConclusion: unavailable ? "笔记不存在" : finalAuditConclusion,
    exceptionCategory: row.task.failureCode
      ? businessFailureReasonLabel(row.task.failureCode)
      : "无异常",
    failureReason:
      detailedFailureReasonList ||
      failureReasonList ||
      businessFailureReasonLabel(row.task.failureMessage || ""),
    needsManualReview: requiresManualReview ? "是" : "否",
    manualReviewStatus,
    manualReviewComment: manual?.comment || "",
    attemptCount: row.task.attempts,
    auditCreatedAt: row.createdAt,
    auditCompletedAt: row.auditedAt,
    auditTime: row.auditedAt,
    taskCreatedAt: row.task.createdAt,
    dateFilterBasis:
      options?.dateType === "CREATED_AT"
        ? "审核创建时间"
        : "审核完成时间",
    failedReasons: unavailable
      ? detailedFailureReasonList
      : detailedFailureReasonList || failureReasonList,
    selfReview,
    matchedRules: row.ruleResults
      .filter((rule) => rule.passed)
      .map((rule) => rule.ruleName)
      .join(separator),
    ruleVersion: row.rulePackageVersion || String(row.ruleVersion),
    reviewedBy: manual?.reviewer?.displayName || "",
    reviewedAt: manual?.createdAt || row.auditedAt,
    remark: manual?.comment || row.task.notes,
  };
}

export async function buildConfiguredWorkbook(input: {
  templates: ImportExportTemplates;
  kind: "auditResults" | "auditTasks";
  records: ExportValueRecord[];
  templateBrand?: ImportTemplateBrand;
  templateType?: ImportTemplateType;
  sections?: Array<{
    sheetName: string;
    records: ExportValueRecord[];
    templateBrand?: ImportTemplateBrand;
    templateType?: ImportTemplateType;
    fields?: readonly StandardField[];
  }>;
}) {
  const { templates, kind } = input;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "VERIDIA";
  workbook.created = new Date();
  const sections = input.sections || [{
    sheetName:
      templates.exportTemplates[kind]?.sheetName ||
      (kind === "auditResults" ? "审核结果" : "审核任务"),
    records: input.records,
    templateBrand: input.templateBrand,
    templateType: input.templateType,
  }];
  for (const section of sections) {
  const { records, templateBrand, templateType, sheetName } = section;
  const sheet = workbook.addWorksheet(sheetName);
  const selected = columns(
    templates,
    kind,
    templateBrand,
    templateType,
    section.fields,
  );
  const widths: Partial<Record<StandardField, number>> = {
    commercePlatform: 16,
    shopName: 24,
    customerName: 20,
    productName: 24,
    productStageTopic: 12,
    orderNumber: 22,
    contentChannel: 16,
    originalUrl: 48,
    publishTime: 22,
    selfReview: 28,
    registrationTime: 22,
    channel: 16,
    customerRemark: 28,
    buyerPurchaseId: 22,
    purchaseOrderNumber: 22,
    purchaseTime: 22,
    purchaseCanCount: 14,
    participationCount: 14,
    xiaohongshuAccount: 22,
    xiaohongshuPublishLink: 52,
    purchaseProductLine: 22,
    complianceResult: 28,
  };
  if (
    kind === "auditResults" &&
    !section.fields &&
    templateBrand !== KABRITA_BRAND_NAME
  ) {
    appendRewardColumns(selected, records);
  }
  sheet.columns = selected.map(({ field, displayName }) => ({
    header: displayName,
    key: field,
    width: widths[field] || Math.min(60, Math.max(14, displayName.length * 3)),
  }));
  for (const record of records) {
    sheet.addRow(
      Object.fromEntries(
        selected.map(({ field }) => {
          const value = record[field];
          return [
            field,
            value === "" || value == null
                ? null
                : value,
          ];
        }),
      ),
    );
  }
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FF000000" } };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFFFF00" },
  };
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 30;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) {
      row.alignment = { vertical: "top", wrapText: true };
    }
  });
  for (const field of ["originalUrl", "noteUrl", "xiaohongshuPublishLink"] as const) {
    const columnIndex = selected.findIndex((column) => column.field === field) + 1;
    if (columnIndex > 0) {
      sheet.getColumn(columnIndex).alignment = {
        vertical: "top",
        wrapText: true,
      };
    }
  }
  for (const { field } of selected) {
    if (fieldDefinition(templates, field, templateBrand)?.type === "datetime") {
      sheet.getColumn(field).numFmt = "yyyy-mm-dd hh:mm:ss";
    }
  }
  const resultField = "selfReview";
  const selfReviewColumn =
    selected.findIndex((column) => column.field === resultField) + 1;
  if (selfReviewColumn > 0 && sheet.rowCount >= 2) {
    addDataValidationRange(sheet, selfReviewColumn, 2, sheet.rowCount, {
        type: "list",
        allowBlank: true,
        formulae: [
          '"Y,N-帖子无法查看,N-内容渠道不支持,N-缺少话题,N-字数不够,N-图片不足,N-阶段不符,N-其他不合规"',
        ],
        showErrorMessage: true,
        errorTitle: "自审值无效",
        error:
          "请选择 Y 或一个预设的 N 类原因，也可以留空。",
    });
  }
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, sheet.rowCount), column: sheet.columnCount },
  };
  }
  return workbook.xlsx.writeBuffer();
}

export function buildConfiguredCsv(input: {
  templates: ImportExportTemplates;
  kind: "auditResults" | "auditTasks";
  records: ExportValueRecord[];
  templateBrand?: ImportTemplateBrand;
  templateType?: ImportTemplateType;
  fields?: readonly StandardField[];
}) {
  const selected = columns(
    input.templates,
    input.kind,
    input.templateBrand,
    input.templateType,
    input.fields,
  );
  if (
    input.kind === "auditResults" &&
    !input.fields &&
    input.templateBrand !== KABRITA_BRAND_NAME
  ) {
    appendRewardColumns(selected, input.records);
  }
  return utf8BomCsv(
    selected.map((column) => column.displayName),
    input.records.map((record) =>
      selected.map(({ field }) => {
        const value = record[field];
        return value instanceof Date
          ? field === "publishTime"
            ? importedDateLabel(value)
            : value.toLocaleString("zh-CN", { hour12: false })
          : exportTextValue(value) ?? "";
      }),
    ),
  );
}

export async function buildImportTemplateWorkbook(
  templates: ImportExportTemplates,
  options?: {
    templateBrand?: ImportTemplateBrand;
    templateType?: DownloadableImportTemplateType;
    activityNames?: readonly string[];
    activities?: ReadonlyArray<{
      name: string;
      month?: string | null;
      year?: number | null;
      contentChannel: "XIAOHONGSHU" | "DOUYIN";
    }>;
  },
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "VERIDIA";
  const templateType =
    options?.templateType ||
    (options?.templateBrand === KABRITA_BRAND_NAME
      ? "KABRITA"
      : "DANONE_CUSTOMER");
  const sheet = workbook.addWorksheet(
    templateType === "KABRITA"
      ? "佳贝艾特导入"
      : "达能客户导入",
  );
  const fields: readonly StandardField[] =
    templateType === "KABRITA"
      ? KABRITA_IMPORT_FIELDS
      : DANONE_CUSTOMER_IMPORT_FIELDS;
  const widths: Partial<Record<StandardField, number>> = {
    commercePlatform: 16,
    shopName: 24,
    customerName: 20,
    productName: 26,
    productStage: 12,
    orderNumber: 22,
    contentChannel: 18,
    noteUrl: 52,
    publishTime: 22,
    activityMonth: 20,
    activityName: 38,
    registrationTime: 22,
    channel: 16,
    customerRemark: 28,
    buyerPurchaseId: 22,
    purchaseOrderNumber: 22,
    purchaseTime: 22,
    purchaseCanCount: 14,
    participationCount: 14,
    xiaohongshuAccount: 22,
    xiaohongshuPublishLink: 52,
    purchaseProductLine: 22,
    complianceResult: 18,
  };
  sheet.columns = fields.map((field) => ({
    header:
      templateType === "KABRITA"
        ? fieldDefinition(templates, field, options?.templateBrand).displayName
        : danoneTemplateFieldDisplayName(field, templateType),
    key: field,
    width:
      widths[field] ||
      Math.min(
        52,
        Math.max(
          14,
          (templateType === "KABRITA"
            ? fieldDefinition(templates, field, options?.templateBrand).displayName
            : danoneTemplateFieldDisplayName(field, templateType)).length * 3,
        ),
      ),
  }));
  sheet.addRow(
    Object.fromEntries(
      fields.map((field) => [field, templates.examples[field] || ""]),
    ),
  );
  if (templateType === "KABRITA") {
    for (const field of fields) {
      sheet.getCell(2, fields.indexOf(field) + 1).value =
        KABRITA_TEMPLATE_EXAMPLES[
          field as keyof typeof KABRITA_TEMPLATE_EXAMPLES
        ] || "";
    }
  }
  const activityMonthColumn = fields.indexOf("activityMonth") + 1;
  const activities = options?.activities || (options?.activityNames || []).map(
    (name) => ({
      name,
      contentChannel: name.includes("抖音")
        ? "DOUYIN" as const
        : "XIAOHONGSHU" as const,
    }),
  );
  const exampleActivity = activities[0];
  const publishTimeColumn = fields.indexOf("publishTime") + 1;
  if (publishTimeColumn > 0) {
    sheet.getCell(2, publishTimeColumn).value = importedPublishTimeValue(
      templates.examples.publishTime,
    );
    sheet.getColumn(publishTimeColumn).numFmt = "yyyy-mm-dd hh:mm:ss";
  }
  const productStageColumn = fields.indexOf("productStage") + 1;
  if (productStageColumn > 0) {
    addDataValidationRange(
      sheet,
      productStageColumn,
      2,
      templates.dataValidation.maxRows + 1,
      {
        type: "list",
        allowBlank: false,
        formulae: ['"IFFO,GUM"'],
        showErrorMessage: true,
        errorTitle: "阶段无效",
        error: "阶段仅支持 IFFO 或 GUM",
      },
    );
  }
  const contentChannelColumn = fields.indexOf("contentChannel") + 1;
  if (contentChannelColumn > 0) {
    if (exampleActivity) {
      sheet.getCell(2, contentChannelColumn).value =
        exampleActivity.contentChannel === "DOUYIN" ? "抖音" : "小红书";
    }
    addDataValidationRange(sheet, contentChannelColumn, 2, 10_000, {
        type: "list",
        allowBlank: false,
        formulae: ['"小红书,抖音"'],
        showErrorMessage: true,
        errorTitle: "内容渠道无效",
        error: "内容渠道仅支持小红书或抖音，并且必须与活动及链接一致。",
    });
  }
  const productStageDetailColumn = fields.indexOf("productStageDetail") + 1;
  if (productStageDetailColumn > 0) {
    addDataValidationRange(
      sheet,
      productStageDetailColumn,
      2,
      templates.dataValidation.maxRows + 1,
      {
        type: "list",
        allowBlank: false,
        formulae: ['"P段,1段,2段,3段,4段,1+段,2+段"'],
        showErrorMessage: true,
        errorTitle: "段位无效",
        error: "段位请填写 P段、1段、2段、3段、4段、1+或2+。",
      },
    );
  }
  if (activityMonthColumn > 0) {
    const configuredMonths = [...new Set(activities.flatMap((activity) => {
      const explicit = normalizeImportedActivityMonth(
        "month" in activity ? activity.month : null,
      );
      if (explicit) return [`${explicit.month}月`];
      const fromName = /(\d{1,2})月/u.exec(activity.name);
      const parsed = normalizeImportedActivityMonth(fromName?.[1]);
      return parsed ? [`${parsed.month}月`] : [];
    }))].sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));
    const activityMonths = configuredMonths.length
      ? configuredMonths
      : Array.from({ length: 12 }, (_, index) => `${index + 1}月`);
    sheet.getCell(2, activityMonthColumn).value = activityMonths[0] || "";
    const activitySheet = workbook.addWorksheet("活动月份列表", {
      state: "veryHidden",
    });
    activitySheet.getCell("A1").value = "活动月份";
    activityMonths.forEach((month, index) => {
      activitySheet.getCell(index + 2, 1).value = month;
    });
    workbook.definedNames.add(
      `'活动月份列表'!$A$2:$A$${activityMonths.length + 1}`,
      "VERIDIA_ACTIVITY_MONTHS",
    );
    addDataValidationRange(sheet, activityMonthColumn, 2, 10_000, {
        type: "list",
        allowBlank: true,
        formulae: ["VERIDIA_ACTIVITY_MONTHS"],
        showErrorMessage: true,
        errorTitle: "活动月份无效",
        error: "请选择 1月 至 12月；同一工作表只能填写一个活动月份。",
    });
  }
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FF000000" } };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFFFF00" },
  };
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 30;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(sheet.rowCount, 1), column: sheet.columnCount },
  };
  const linkColumn =
    fields.indexOf(
      templateType === "KABRITA"
        ? "xiaohongshuPublishLink"
        : "noteUrl",
    ) + 1;
  if (linkColumn > 0) {
    sheet.getColumn(linkColumn).alignment = {
      vertical: "top",
      wrapText: true,
    };
  }

  const instructions = workbook.addWorksheet("填写说明");
  instructions.columns = [
    { header: "标准字段", key: "field", width: 22 },
    { header: "显示名称", key: "displayName", width: 20 },
    { header: "是否必填", key: "required", width: 12 },
    { header: "字段说明", key: "description", width: 48 },
    { header: "支持别名", key: "aliases", width: 72 },
  ];
  instructions.addRow({
    field: "模板版本",
    displayName: templates.templateVersion,
    required: "",
    description: `模板Schema ${templates.schemaVersion}`,
    aliases: "模板随审核规则同步更新",
  });
  instructions.addRow({
    field: "活动月份填写要求",
    displayName: "活动月份（必填）",
    required: "是",
    description:
      "活动月份为当前工作表统一月份，只需填写一次，例如 9月。系统会根据产品及内容渠道自动匹配对应的小红书/抖音活动与审核规则。",
    aliases: "支持 9月、09月、9、09、YYYY-MM、YYYY/MM",
  });
  instructions.addRow({
    field: "抖音填写示例",
    displayName: "内容渠道：抖音",
    required: "",
    description: "内容渠道填写抖音后，系统会按产品和活动月份匹配抖音 Campaign；链接支持 https://www.douyin.com/note/...、https://www.douyin.com/video/... 或 https://v.douyin.com/...。",
    aliases: "小红书和抖音同月活动互不混用",
  });
  instructions.addRow({
    field: "模板类型",
    displayName: IMPORT_TEMPLATE_TYPE_LABELS[templateType],
    required: "",
    description:
      templateType === "DANONE_CUSTOMER"
        ? "适用于达能客户新格式：阶段填写 IFFO 或 GUM，段位填写 P段、1段、2段、3段、4段、1+段或2+段，两列均为必填；历史模板填反时系统会按值域自动识别。"
        : "适用于佳贝艾特业务模板。",
    aliases: "活动月份是 Sheet 级属性",
  });
  for (const field of fields) {
    instructions.addRow({
      field,
      displayName:
        templateType === "KABRITA"
          ? fieldDefinition(templates, field, options?.templateBrand).displayName
          : danoneTemplateFieldDisplayName(field, templateType),
      required:
        templateType === "KABRITA"
          ? KABRITA_REQUIRED_FIELDS.includes(field as never)
            ? "是"
            : "否"
          : "是",
      description: fieldDefinition(
        templates,
        field,
        options?.templateBrand,
      ).description,
      aliases:
        templateType === "KABRITA"
          ? ""
          : (templates.fieldAliases[field] || []).join("、"),
    });
  }
  instructions.getRow(1).font = { bold: true };
  const metadata = workbook.addWorksheet("VERIDIA模板信息", {
    state: "veryHidden",
  });
  metadata.getCell("A1").value = "templateType";
  metadata.getCell("B1").value = templateType;
  metadata.getCell("A2").value = "templateVersion";
  metadata.getCell("B2").value = templates.templateVersion;
  return workbook.xlsx.writeBuffer();
}

export function buildUnifiedAuditResultsWorkbook(input: {
  templates: ImportExportTemplates;
  danoneRecords: ExportValueRecord[];
  kabritaRecords: ExportValueRecord[];
  wyethRecords: ExportValueRecord[];
  nestleRecords: ExportValueRecord[];
}) {
  const auditFields = [
    "mediaType",
    "finalAuditConclusion",
    "publicStatus",
    "topicsAuditResult",
    "imageStatus",
    "bodyStatus",
    "storeTopicAuditResult",
    "likeCount",
    "commentCount",
    "favoriteCount",
    "interactionTotal",
    "interactionAtLeastTen",
    "failedReasons",
  ] as const satisfies readonly StandardField[];
  const appendAuditFields = (
    fields: readonly StandardField[],
  ): StandardField[] => [
    ...fields.filter(
      (field) =>
        field !== "activityMonth" &&
        !auditFields.includes(field as (typeof auditFields)[number]),
    ),
    ...auditFields,
    "activityMonth",
  ];
  return buildConfiguredWorkbook({
    templates: input.templates,
    kind: "auditResults",
    records: [],
    sections: [
      {
        sheetName: UNIFIED_AUDIT_RESULT_SHEET_NAMES[0],
        records: input.danoneRecords,
        templateType: "DANONE_CUSTOMER",
        fields: appendAuditFields(DANONE_CUSTOMER_EXPORT_FIELDS),
      },
      {
        sheetName: UNIFIED_AUDIT_RESULT_SHEET_NAMES[1],
        records: input.kabritaRecords,
        templateBrand: KABRITA_BRAND_NAME,
        fields: appendAuditFields(KABRITA_EXPORT_FIELDS),
      },
      {
        sheetName: UNIFIED_AUDIT_RESULT_SHEET_NAMES[2],
        records: input.wyethRecords,
        templateType: "WYETH",
        fields: appendAuditFields(WYETH_NESTLE_FIELDS),
      },
      {
        sheetName: UNIFIED_AUDIT_RESULT_SHEET_NAMES[3],
        records: input.nestleRecords,
        templateType: "NESTLE",
        fields: appendAuditFields(WYETH_NESTLE_FIELDS),
      },
    ],
  });
}

type UnifiedTemplateActivity = {
  name: string;
  month?: string | null;
  year?: number | null;
  contentChannel: "XIAOHONGSHU" | "DOUYIN";
};

type UnifiedTemplateProduct = {
  id: string;
  code?: string | null;
  name: string;
  brandName: string;
};

function styleImportSheet(
  sheet: ExcelJS.Worksheet,
  fields: readonly StandardField[],
) {
  const widths: Partial<Record<StandardField, number>> = {
    registrant: 18,
    wechatNickname: 22,
    commercePlatform: 18,
    shopName: 28,
    customerName: 20,
    productName: 28,
    productStage: 14,
    productStageDetail: 14,
    orderNumber: 26,
    contentChannel: 18,
    noteUrl: 52,
    publishTime: 22,
    activityMonth: 20,
    activityName: 38,
    customerServiceComment: 32,
    selfReview: 26,
    interactionAtLeastTen: 16,
    registrationTime: 22,
    channel: 16,
    customerRemark: 28,
    buyerPurchaseId: 22,
    purchaseOrderNumber: 24,
    purchaseTime: 22,
    purchaseCanCount: 14,
    participationCount: 14,
    xiaohongshuAccount: 22,
    xiaohongshuPublishLink: 52,
    purchaseProductLine: 24,
    complianceResult: 28,
  };
  fields.forEach((field, index) => {
    sheet.getColumn(index + 1).width = widths[field] || 18;
  });
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FF000000" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 32;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: fields.length },
  };
}

function sameOrderedStrings(actual: readonly string[], expected: readonly string[]) {
  return actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

async function assertUnifiedImportTemplateInvariant(buffer: ExcelJS.Buffer) {
  const generated = new ExcelJS.Workbook();
  await generated.xlsx.load(buffer);
  const visibleBusinessSheets = generated.worksheets
    .filter((sheet) => sheet.state === "visible")
    .map((sheet) => sheet.name);
  const metadata = generated.getWorksheet("VERIDIA模板信息");
  let supportedSheets: string[] = [];
  try {
    const parsed = JSON.parse(metadata?.getCell("B3").text || "null") as unknown;
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
      supportedSheets = parsed;
    }
  } catch {
    supportedSheets = [];
  }
  if (
    !sameOrderedStrings(visibleBusinessSheets, UNIFIED_IMPORT_SHEET_NAMES) ||
    !sameOrderedStrings(supportedSheets, UNIFIED_IMPORT_SHEET_NAMES)
  ) {
    throw new Error(
      `统一模板工作表契约不一致：actual=${JSON.stringify(visibleBusinessSheets)} metadata=${JSON.stringify(supportedSheets)}`,
    );
  }
}

export async function buildUnifiedImportTemplateWorkbook(
  templates: ImportExportTemplates,
  options: {
    activities: readonly UnifiedTemplateActivity[];
    products: readonly UnifiedTemplateProduct[];
  },
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "VERIDIA";

  const danone = workbook.addWorksheet("达能客户导入");
  danone.addRow(
    DANONE_CUSTOMER_IMPORT_FIELDS.map((field) =>
      danoneTemplateFieldDisplayName(field, "DANONE_CUSTOMER"),
    ),
  );
  styleImportSheet(danone, DANONE_CUSTOMER_IMPORT_FIELDS);
  const danoneStage = DANONE_CUSTOMER_IMPORT_FIELDS.indexOf("productStage") + 1;
  const danoneStageDetail = DANONE_CUSTOMER_IMPORT_FIELDS.indexOf("productStageDetail") + 1;
  const danoneChannel = DANONE_CUSTOMER_IMPORT_FIELDS.indexOf("contentChannel") + 1;
  addDataValidationRange(danone, danoneStage, 2, 10_001, {
    type: "list", allowBlank: false, formulae: ['"IFFO,GUM"'],
    showErrorMessage: true, errorTitle: "阶段无效", error: "阶段仅支持 IFFO 或 GUM",
  });
  addDataValidationRange(danone, danoneStageDetail, 2, 10_001, {
    type: "list", allowBlank: false, formulae: ['"P段,1段,2段,3段,4段,1+段,2+段"'],
    showErrorMessage: true, errorTitle: "段位无效", error: "请选择正式段位值",
  });
  addDataValidationRange(danone, danoneChannel, 2, 10_001, {
    type: "list", allowBlank: false, formulae: ['"小红书,抖音"'],
    showErrorMessage: true, errorTitle: "内容渠道无效", error: "内容渠道仅支持小红书或抖音",
  });
  danone.getColumn(DANONE_CUSTOMER_IMPORT_FIELDS.indexOf("publishTime") + 1).numFmt = "yyyy-mm-dd hh:mm:ss";

  const kabrita = workbook.addWorksheet("佳贝艾特客户导入");
  kabrita.addRow(
    KABRITA_IMPORT_FIELDS.map((field) => KABRITA_FIELD_DEFINITIONS[field].displayName),
  );
  styleImportSheet(kabrita, KABRITA_IMPORT_FIELDS);
  kabrita.getColumn(KABRITA_IMPORT_FIELDS.indexOf("registrationTime") + 1).numFmt = "yyyy-mm-dd hh:mm:ss";
  kabrita.getColumn(KABRITA_IMPORT_FIELDS.indexOf("purchaseTime") + 1).numFmt = "yyyy-mm-dd hh:mm:ss";

  const addBrandSheet = (name: string) => {
    const sheet = workbook.addWorksheet(name);
    sheet.addRow(
      WYETH_NESTLE_FIELDS.map((field) => WYETH_NESTLE_FIELD_DEFINITIONS[field].displayName),
    );
    styleImportSheet(sheet, WYETH_NESTLE_FIELDS);
    addDataValidationRange(
      sheet,
      WYETH_NESTLE_FIELDS.indexOf("contentChannel") + 1,
      2,
      10_001,
      {
        type: "list", allowBlank: false, formulae: ['"小红书,抖音"'],
        showErrorMessage: true, errorTitle: "内容渠道无效", error: "内容渠道仅支持小红书或抖音",
      },
    );
    sheet.getColumn(WYETH_NESTLE_FIELDS.indexOf("publishTime") + 1).numFmt = "yyyy-mm-dd hh:mm:ss";
    sheet.getCell(1, WYETH_NESTLE_FIELDS.indexOf("customerServiceComment") + 1).note =
      "格式：日期-已留言/已修改";
    return sheet;
  };
  const wyeth = addBrandSheet(WYETH_SHEET_NAME);
  const nestle = addBrandSheet(NESTLE_SHEET_NAME);

  const normalizedActivityMonths = [...new Set(
    options.activities
      .map((activity) => normalizeImportedActivityMonth(activity.month))
      .filter((value): value is NonNullable<typeof value> => Boolean(value))
      .map((value) => `${value.month}月`),
  )].sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));
  const activityMonths = normalizedActivityMonths.length
    ? normalizedActivityMonths
    : Array.from({ length: 12 }, (_, index) => `${index + 1}月`);
  const activitySheet = workbook.addWorksheet("活动月份列表", { state: "veryHidden" });
  activitySheet.addRow(["活动月份"]);
  activityMonths.forEach((month) => activitySheet.addRow([month]));
  workbook.definedNames.add(
    `'活动月份列表'!$A$2:$A$${activityMonths.length + 1}`,
    "VERIDIA_ACTIVITY_MONTHS",
  );
  for (const [sheet, fields] of [
    [danone, DANONE_CUSTOMER_IMPORT_FIELDS],
    [kabrita, KABRITA_IMPORT_FIELDS],
    [wyeth, WYETH_NESTLE_FIELDS],
    [nestle, WYETH_NESTLE_FIELDS],
  ] as const) {
    addDataValidationRange(sheet, fields.indexOf("activityMonth") + 1, 2, 10_001, {
      type: "list", allowBlank: true, formulae: ["VERIDIA_ACTIVITY_MONTHS"],
      showErrorMessage: true, errorTitle: "活动月份无效",
      error: "请选择 1月 至 12月；同一工作表只能填写一个活动月份。",
    });
  }

  const wyethProductOptions = buildWyethNestleProductOptions(options.products, "惠氏");
  const nestleProductOptions = buildWyethNestleProductOptions(options.products, "雀巢");
  const productSheet = workbook.addWorksheet("产品列表", { state: "veryHidden" });
  productSheet.addRow(["惠氏产品", "雀巢产品", "productId", "品牌", "正式产品名"]);
  const optionRows = Math.max(wyethProductOptions.length, nestleProductOptions.length);
  for (let index = 0; index < optionRows; index += 1) {
    const wyethOption = wyethProductOptions[index];
    const nestleOption = nestleProductOptions[index];
    productSheet.addRow([
      wyethOption?.value || "",
      nestleOption?.value || "",
      wyethOption?.product.id || nestleOption?.product.id || "",
      wyethOption?.product.brandName || nestleOption?.product.brandName || "",
      wyethOption?.product.name || nestleOption?.product.name || "",
    ]);
  }
  if (wyethProductOptions.length) {
    workbook.definedNames.add(
      `'产品列表'!$A$2:$A$${wyethProductOptions.length + 1}`,
      "VERIDIA_WYETH_PRODUCTS",
    );
    addDataValidationRange(
      wyeth,
      WYETH_NESTLE_FIELDS.indexOf("productName") + 1,
      2,
      10_001,
      {
        type: "list", allowBlank: false, formulae: ["VERIDIA_WYETH_PRODUCTS"],
        showErrorMessage: true, errorTitle: "产品系列无效", error: "请选择当前有效的惠氏产品。",
      },
    );
  }
  if (nestleProductOptions.length) {
    workbook.definedNames.add(
      `'产品列表'!$B$2:$B$${nestleProductOptions.length + 1}`,
      "VERIDIA_NESTLE_PRODUCTS",
    );
    addDataValidationRange(
      nestle,
      WYETH_NESTLE_FIELDS.indexOf("productName") + 1,
      2,
      10_001,
      {
        type: "list", allowBlank: false, formulae: ["VERIDIA_NESTLE_PRODUCTS"],
        showErrorMessage: true, errorTitle: "产品系列无效", error: "请选择当前有效的雀巢产品。",
      },
    );
  }

  const instructions = workbook.addWorksheet("填写说明", { state: "hidden" });
  instructions.addRow(["业务 Sheet", "填写说明"]);
  const monthInstruction =
    "活动月份为当前工作表统一月份，只需填写一次，例如 9月。系统会根据产品及内容渠道自动匹配对应的小红书/抖音活动与审核规则。";
  instructions.addRow(["达能客户导入", monthInstruction]);
  instructions.addRow(["佳贝艾特客户导入", `${monthInstruction}“是否符合”为系统输出列，导入值不参与审核。`]);
  instructions.addRow([WYETH_SHEET_NAME, `${monthInstruction}客服修改留言格式：日期-已留言/已修改；内部自审和互动量≥10由系统重新生成。`]);
  instructions.addRow([NESTLE_SHEET_NAME, `${monthInstruction}客服修改留言格式：日期-已留言/已修改；内部自审和互动量≥10由系统重新生成。`]);
  instructions.getRow(1).font = { bold: true };

  const metadata = workbook.addWorksheet("VERIDIA模板信息", { state: "veryHidden" });
  metadata.addRow(["templateType", "UNIFIED"]);
  metadata.addRow(["templateVersion", templates.templateVersion]);
  metadata.addRow(["supportedSheets", JSON.stringify(UNIFIED_IMPORT_SHEET_NAMES)]);
  metadata.addRow(["sheetName", "templateType"]);
  metadata.addRow(["达能客户导入", "DANONE_CUSTOMER"]);
  metadata.addRow(["佳贝艾特客户导入", "KABRITA"]);
  metadata.addRow([WYETH_SHEET_NAME, "WYETH"]);
  metadata.addRow([NESTLE_SHEET_NAME, "NESTLE"]);
  const buffer = await workbook.xlsx.writeBuffer();
  await assertUnifiedImportTemplateInvariant(buffer);
  return buffer;
}

export function buildImportTemplateCsv(
  templates: ImportExportTemplates,
  options?: {
    templateBrand?: ImportTemplateBrand;
    activityNames?: readonly string[];
  },
) {
  const fields: readonly StandardField[] =
    options?.templateBrand === KABRITA_BRAND_NAME
      ? KABRITA_IMPORT_FIELDS
      : templates.columnOrder.import;
  return utf8BomCsv(
    fields.map(
      (field) =>
        fieldDefinition(templates, field, options?.templateBrand).displayName,
    ),
    [
      fields.map((field) =>
        field === "activityName"
          ? options?.activityNames?.[0] || ""
          : options?.templateBrand === KABRITA_BRAND_NAME
          ? KABRITA_TEMPLATE_EXAMPLES[
              field as keyof typeof KABRITA_TEMPLATE_EXAMPLES
            ] || ""
          : templates.examples[field] || "",
      ),
    ],
  );
}

export function buildBrandedAuditResultsCsv(input: {
  templates: ImportExportTemplates;
  sections: Array<{
    title: string;
    records: ExportValueRecord[];
    templateBrand?: ImportTemplateBrand;
    templateType?: ImportTemplateType;
    fields?: readonly StandardField[];
  }>;
}) {
  const sections = input.sections.map((section) => {
    const csv = buildConfiguredCsv({
      templates: input.templates,
      kind: "auditResults",
      records: section.records,
      templateBrand: section.templateBrand,
      templateType: section.templateType,
      fields: section.fields,
    }).replace(/^\uFEFF/u, "");
    return `${section.title}\r\n${csv}`;
  });
  return `\uFEFF${sections.join("\r\n\r\n")}`;
}
