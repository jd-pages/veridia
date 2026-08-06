import ExcelJS from "exceljs";
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

export type ExportValueRecord = Partial<Record<StandardField, unknown>>;

export interface CompactAuditResultExportSourceRow {
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
  task: {
    url: string;
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
    campaign?: { name: string };
  };
  note: {
    url: string;
    finalUrl: string | null;
    publishedAt: Date | null;
    title: string | null;
    body: string | null;
    topics?: Array<{ displayText: string }>;
  };
  manualReviews: Array<{ result: string }>;
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

const AUDIT_RESULT_EXCEL_PRODUCT_SERIES_NAMES: Record<string, string> = {
  爱他美澳洲白金版: "澳白",
  爱他美德国白金版: "德白",
  爱他美奇迹绿罐: "绿罐",
  爱他美亲熠5HMO: "白罐",
  爱他美至熠: "至熠",
};

function auditResultExcelProductSeriesName(value: unknown) {
  return typeof value === "string"
    ? AUDIT_RESULT_EXCEL_PRODUCT_SERIES_NAMES[value] || value
    : value;
}

function columns(
  templates: ImportExportTemplates,
  kind: keyof ImportExportTemplates["columnOrder"],
  templateBrand?: ImportTemplateBrand,
) {
  if (kind === "auditResults" && templateBrand === KABRITA_BRAND_NAME) {
    return KABRITA_EXPORT_FIELDS.map((field) => ({
      field,
      displayName:
        field === "activityName"
          ? "活动名称"
          : KABRITA_FIELD_DEFINITIONS[field].displayName,
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
  const finalStatus = row.manualReviews[0]?.result || row.autoStatus;
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
  const failureReasonList = list(row.failureReasons, " ");
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
    /CONTENT_CHANNEL_UNSUPPORTED|UNSUPPORTED_CONTENT_CHANNEL|内容渠道.{0,8}(?:不支持|暂不支持)|(?:不支持|暂不支持).{0,8}内容渠道|非小红书|抖音|快手/iu.test(
      evidence,
    )
  ) {
    return "N-内容渠道不支持";
  }
  if (finalStatus !== "FAILED") return "";
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
  let details = auditConclusionFailureReasons(row).filter(
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

/**
 * 审核结果下载只读取业务模板实际需要的数据。
 * 历史结果中的规则快照或技术审核字段即使不完整，也不应阻断人工导出。
 */
export function auditResultToCompactExportRecord(
  row: CompactAuditResultExportSourceRow,
): ExportValueRecord {
  const importedMetadata = importedTaskMetadataFromNotes(row.task.notes);
  const commercePlatform =
    parseCommercePlatform(row.task.commercePlatform) ||
    parseCommercePlatform(importedMetadata.platform);
  const channel =
    resolveTaskChannel(row.task) ||
    parseContentChannel(importedMetadata.contentChannel);
  return {
    commercePlatform: commercePlatformLabel(commercePlatform),
    shopName: importedMetadata.shopName,
    customerName: importedMetadata.customerName,
    productName: row.task.product.seriesName || row.task.product.name,
    productStageTopic: productStageTopicLabel(row.task.productStage),
    orderNumber: importedMetadata.orderNumber,
    contentChannel: contentChannelLabel(channel),
    originalUrl: row.task.url,
    publishTime: importedMetadata.publishTime
      ? importedPublishTimeValue(importedMetadata.publishTime)
      : row.note.publishedAt,
    activityName: importedMetadata.activityName || row.task.campaign?.name || "",
    selfReview: detailedSelfReview(row),
  };
}

export function auditResultToKabritaExportRecord(
  row: CompactAuditResultExportSourceRow,
): ExportValueRecord {
  const raw = importedTemplateMetadataFromNotes(row.task.notes)?.rawValues || {};
  const imported = importedTaskMetadataFromNotes(row.task.notes);
  return {
    registrationTime: raw.registrationTime || "",
    channel: raw.channel || "",
    shopName: raw.shopName || imported.shopName,
    customerRemark: raw.customerRemark || "",
    buyerPurchaseId: raw.buyerPurchaseId || "",
    purchaseOrderNumber:
      raw.purchaseOrderNumber || imported.orderNumber,
    purchaseTime: raw.purchaseTime || "",
    purchaseCanCount: raw.purchaseCanCount || "",
    participationCount: raw.participationCount || "",
    xiaohongshuAccount: raw.xiaohongshuAccount || "",
    xiaohongshuPublishLink:
      raw.xiaohongshuPublishLink || row.task.url,
    purchaseProductLine:
      raw.purchaseProductLine ||
      row.task.product.seriesName ||
      row.task.product.name,
    activityName: raw.activityName || imported.activityName || row.task.campaign?.name || "",
    selfReview: detailedSelfReview(row),
  };
}

export function auditResultToExportRecord(row: {
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
}, templates: ImportExportTemplates, options?: {
  dateType?: string;
}): ExportValueRecord {
  const separator =
    templates.exportTemplates.auditResults?.multiValueSeparator || "、";
  const manual = row.manualReviews[0];
  const requiresManualReview =
    row.autoStatus === "NEEDS_REVIEW" ||
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
  const failureReasonList = list(row.failureReasons, separator);
  const detailedFailureReasonList = auditConclusionFailureReasons(row).join(
    separator,
  );
  const autoAuditResult = businessStatusLabel(row.autoStatus, "audit");
  const manualAuditResult = manual
    ? businessStatusLabel(manual.result, "audit")
    : "";
  const finalAuditConclusion = manualAuditResult || autoAuditResult;
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
    noteUrl: row.note.finalUrl || row.note.url,
    originalUrl: row.task.url,
    finalUrl: row.task.finalUrl || row.note.finalUrl || row.note.url,
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
      : detailedFailureReasonList || list(row.failureReasons, separator),
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
  sections?: Array<{
    sheetName: string;
    records: ExportValueRecord[];
    templateBrand?: ImportTemplateBrand;
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
  }];
  for (const section of sections) {
  const { records, templateBrand, sheetName } = section;
  const sheet = workbook.addWorksheet(sheetName);
  const selected = columns(templates, kind, templateBrand);
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
  sheet.columns = selected.map(({ field, displayName }) => ({
    header: displayName,
    key: field,
    width: widths[field] || Math.min(60, Math.max(14, displayName.length * 3)),
  }));
  for (const record of records) {
    sheet.addRow(
      Object.fromEntries(
        selected.map(({ field }) => {
          const value =
            kind === "auditResults" &&
            templateBrand !== KABRITA_BRAND_NAME &&
            field === "productName"
              ? auditResultExcelProductSeriesName(record[field])
              : record[field];
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
  for (const field of ["originalUrl", "xiaohongshuPublishLink"] as const) {
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
  if (selfReviewColumn > 0) {
    for (let row = 2; row <= Math.max(sheet.rowCount, 2); row += 1) {
      sheet.getCell(row, selfReviewColumn).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [
          '"Y,N-帖子无法查看,N-内容渠道不支持,N-缺少话题,N-字数不够,N-图片不足,N-阶段不符,N-其他不合规"',
        ],
        showErrorMessage: true,
        errorTitle: "自审值无效",
        error:
          "请选择 Y 或一个预设的 N 类原因，也可以留空。",
      };
    }
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
}) {
  const selected = columns(
    input.templates,
    input.kind,
    input.templateBrand,
  );
  return utf8BomCsv(
    selected.map((column) => column.displayName),
    input.records.map((record) =>
      selected.map(({ field }) => {
        const value = record[field];
        return value instanceof Date
          ? field === "publishTime"
            ? importedDateLabel(value)
            : value.toLocaleString("zh-CN", { hour12: false })
          : value ?? "";
      }),
    ),
  );
}

export async function buildImportTemplateWorkbook(
  templates: ImportExportTemplates,
  options?: {
    templateBrand?: ImportTemplateBrand;
    activityNames?: readonly string[];
  },
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "VERIDIA";
  const sheet = workbook.addWorksheet(
    options?.templateBrand === KABRITA_BRAND_NAME
      ? "佳贝艾特导入"
      : templates.importTemplates.default.sheetName,
  );
  const fields: readonly StandardField[] =
    options?.templateBrand === KABRITA_BRAND_NAME
      ? KABRITA_IMPORT_FIELDS
      : templates.columnOrder.import;
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
    header: fieldDefinition(templates, field, options?.templateBrand).displayName,
    key: field,
    width:
      widths[field] ||
      Math.min(
        52,
        Math.max(
          14,
          fieldDefinition(templates, field, options?.templateBrand).displayName
            .length * 3,
        ),
      ),
  }));
  sheet.addRow(
    Object.fromEntries(
      fields.map((field) => [field, templates.examples[field] || ""]),
    ),
  );
  if (options?.templateBrand === KABRITA_BRAND_NAME) {
    for (const field of fields) {
      sheet.getCell(2, fields.indexOf(field) + 1).value =
        KABRITA_TEMPLATE_EXAMPLES[
          field as keyof typeof KABRITA_TEMPLATE_EXAMPLES
        ] || "";
    }
  }
  const activityNameColumn = fields.indexOf("activityName") + 1;
  const activityNames = [...new Set(
    (options?.activityNames || []).map((name) => name.trim()).filter(Boolean),
  )];
  if (activityNameColumn > 0) {
    sheet.getCell(2, activityNameColumn).value = activityNames[0] || "";
  }
  const publishTimeColumn = fields.indexOf("publishTime") + 1;
  if (publishTimeColumn > 0) {
    sheet.getCell(2, publishTimeColumn).value = importedPublishTimeValue(
      templates.examples.publishTime,
    );
    sheet.getColumn(publishTimeColumn).numFmt = "yyyy-mm-dd hh:mm:ss";
  }
  const productStageColumn = fields.indexOf("productStage") + 1;
  if (productStageColumn > 0) {
    for (
      let rowNumber = 2;
      rowNumber <= templates.dataValidation.maxRows + 1;
      rowNumber += 1
    ) {
      sheet.getCell(rowNumber, productStageColumn).dataValidation = {
        type: "list",
        allowBlank: false,
        formulae: ['"IFFO,GUM"'],
        showErrorMessage: true,
        errorTitle: "产品阶段话题无效",
        error: "产品阶段话题请填写 IFFO 或 GUM。",
      };
    }
  }
  const productStageDetailColumn = fields.indexOf("productStageDetail") + 1;
  if (productStageDetailColumn > 0) {
    for (
      let rowNumber = 2;
      rowNumber <= templates.dataValidation.maxRows + 1;
      rowNumber += 1
    ) {
      sheet.getCell(rowNumber, productStageDetailColumn).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: ['"P段,1段,2段,3段,4段,1+段,2+段"'],
        showErrorMessage: true,
        errorTitle: "产品段位无效",
        error: "段位请填写 P段、1段、2段、3段、4段、1+段或2+段。",
      };
    }
  }
  if (activityNameColumn > 0 && activityNames.length) {
    const activitySheet = workbook.addWorksheet("活动列表", {
      state: "veryHidden",
    });
    activitySheet.getCell("A1").value = "活动名称";
    activityNames.forEach((name, index) => {
      activitySheet.getCell(index + 2, 1).value = name;
    });
    workbook.definedNames.add(
      `'活动列表'!$A$2:$A$${activityNames.length + 1}`,
      "VERIDIA_ACTIVITY_NAMES",
    );
    for (let rowNumber = 2; rowNumber <= 10_000; rowNumber += 1) {
      sheet.getCell(rowNumber, activityNameColumn).dataValidation = {
        type: "list",
        allowBlank: false,
        formulae: ["VERIDIA_ACTIVITY_NAMES"],
        showErrorMessage: true,
        errorTitle: "活动名称无效",
        error: "请选择活动管理中当前启用的完整活动名称。",
      };
    }
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
      options?.templateBrand === KABRITA_BRAND_NAME
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
    field: "活动名称填写要求",
    displayName: "活动名称（必填）",
    required: "是",
    description:
      "必须填写“活动管理”中显示的完整活动名称，不能填写简称或自行改写。",
    aliases:
      "正确示例：达能2026年8月小红书种草审核、佳贝艾特2026年8月小红书种草审核、爱他美2026年8月小红书种草审核；错误示例：2026年8月-达能-UGC、达能8月活动、8月UGC",
  });
  for (const field of fields) {
    instructions.addRow({
      field,
      displayName: fieldDefinition(
        templates,
        field,
        options?.templateBrand,
      ).displayName,
      required:
        options?.templateBrand === KABRITA_BRAND_NAME
          ? KABRITA_REQUIRED_FIELDS.includes(field as never)
            ? "是"
            : "否"
          : templates.requiredFields.includes(field)
            ? "是"
            : "否",
      description: fieldDefinition(
        templates,
        field,
        options?.templateBrand,
      ).description,
      aliases:
        options?.templateBrand === KABRITA_BRAND_NAME
          ? ""
          : (templates.fieldAliases[field] || []).join("、"),
    });
  }
  instructions.getRow(1).font = { bold: true };
  return workbook.xlsx.writeBuffer();
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
  }>;
}) {
  const sections = input.sections.map((section) => {
    const csv = buildConfiguredCsv({
      templates: input.templates,
      kind: "auditResults",
      records: section.records,
      templateBrand: section.templateBrand,
    }).replace(/^\uFEFF/u, "");
    return `${section.title}\r\n${csv}`;
  });
  return `\uFEFF${sections.join("\r\n\r\n")}`;
}
