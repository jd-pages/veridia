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
import {
  importedPublishTimeValue,
  importedTaskMetadataFromNotes,
} from "@/lib/import-task-metadata";
import type { ImportExportTemplates, StandardField } from "./types";
import { utf8BomCsv } from "./tabular";

export type ExportValueRecord = Partial<Record<StandardField, unknown>>;

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

function columns(
  templates: ImportExportTemplates,
  kind: keyof ImportExportTemplates["columnOrder"],
) {
  const auditResultDisplayNames: Partial<Record<StandardField, string>> = {
    platform: "平台",
    shopName: "店铺名称",
    customerName: "客户名",
    productName: "产品系列",
    productStageTopic: "阶段",
    orderNumber: "订单编号",
    contentChannel: "内容渠道",
    originalUrl: "链接",
    publishTime: "发帖时间",
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
  const imageProblem =
    !unavailable &&
    ([
      row.imageExtractionStatus,
      row.imageStatus,
      row.task.failureCode,
      row.task.failureMessage,
      failureReasonList,
    ]
      .filter(Boolean)
      .join(" ")
      .match(
        /IMAGES_READ_FAILED|IMAGE_COUNT_INSUFFICIENT|IMAGE_COUNT_INVALID|NON_COMPLIANT|图片读取失败|图片数量读取失败|图片数量不足|图片不足|图片数量不合规|看不到奶粉段数/iu,
      ) !== null);
  const selfReview = (manual?.result || row.autoStatus) === "PASSED"
    ? "Y"
    : unavailable
      ? "N-帖子无法查看"
      : imageProblem
        ? "N-图片看不到奶粉段数"
        : "";
  const importedMetadata = importedTaskMetadataFromNotes(row.task.notes);
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
    platform: importedMetadata.platform || "小红书",
    shopName: importedMetadata.shopName,
    customerName: importedMetadata.customerName,
    productName: row.task.product.seriesName || row.task.product.name,
    orderNumber: importedMetadata.orderNumber,
    contentChannel: importedMetadata.contentChannel || "小红书",
    activityName: row.task.campaign.name,
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
      ? "笔记不存在"
      : list(row.failureReasons, separator),
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
}) {
  const { templates, kind, records } = input;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "VERIDIA";
  workbook.created = new Date();
  const sheetName =
    templates.exportTemplates[kind]?.sheetName ||
    (kind === "auditResults" ? "审核结果" : "审核任务");
  const sheet = workbook.addWorksheet(sheetName);
  const selected = columns(templates, kind);
  const widths: Partial<Record<StandardField, number>> = {
    platform: 16,
    shopName: 24,
    customerName: 20,
    productName: 24,
    productStageTopic: 12,
    orderNumber: 22,
    contentChannel: 16,
    originalUrl: 48,
    publishTime: 22,
    selfReview: 28,
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
  for (const field of ["originalUrl"] as const) {
    const columnIndex = selected.findIndex((column) => column.field === field) + 1;
    if (columnIndex > 0) {
      sheet.getColumn(columnIndex).alignment = {
        vertical: "top",
        wrapText: true,
      };
    }
  }
  for (const { field } of selected) {
    if (templates.fieldDefinitions[field].type === "datetime") {
      sheet.getColumn(field).numFmt = "yyyy-mm-dd hh:mm:ss";
    }
  }
  const selfReviewColumn =
    selected.findIndex((column) => column.field === "selfReview") + 1;
  if (selfReviewColumn > 0) {
    for (let row = 2; row <= Math.max(sheet.rowCount, 2); row += 1) {
      sheet.getCell(row, selfReviewColumn).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: ['"Y,N-帖子无法查看,N-图片看不到奶粉段数"'],
        showErrorMessage: true,
        errorTitle: "自审值无效",
        error: "请选择 Y、N-帖子无法查看、N-图片看不到奶粉段数，或留空。",
      };
    }
  }
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, sheet.rowCount), column: sheet.columnCount },
  };
  return workbook.xlsx.writeBuffer();
}

export function buildConfiguredCsv(input: {
  templates: ImportExportTemplates;
  kind: "auditResults" | "auditTasks";
  records: ExportValueRecord[];
}) {
  const selected = columns(input.templates, input.kind);
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
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "VERIDIA";
  const sheet = workbook.addWorksheet(
    templates.importTemplates.default.sheetName,
  );
  const fields = templates.columnOrder.import;
  const widths: Partial<Record<StandardField, number>> = {
    platform: 16,
    shopName: 24,
    customerName: 20,
    productName: 26,
    productStage: 12,
    orderNumber: 22,
    contentChannel: 18,
    noteUrl: 52,
    publishTime: 22,
  };
  sheet.columns = fields.map((field) => ({
    header: templates.fieldDefinitions[field].displayName,
    key: field,
    width:
      widths[field] ||
      Math.min(
        52,
        Math.max(14, templates.fieldDefinitions[field].displayName.length * 3),
      ),
  }));
  sheet.addRow(
    Object.fromEntries(
      fields.map((field) => [field, templates.examples[field] || ""]),
    ),
  );
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
  const linkColumn = fields.indexOf("noteUrl") + 1;
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
  for (const field of fields) {
    instructions.addRow({
      field,
      displayName: templates.fieldDefinitions[field].displayName,
      required: templates.requiredFields.includes(field) ? "是" : "否",
      description: templates.fieldDefinitions[field].description,
      aliases: (templates.fieldAliases[field] || []).join("、"),
    });
  }
  instructions.getRow(1).font = { bold: true };
  return workbook.xlsx.writeBuffer();
}

export function buildImportTemplateCsv(templates: ImportExportTemplates) {
  const fields = templates.columnOrder.import;
  return utf8BomCsv(
    fields.map((field) => templates.fieldDefinitions[field].displayName),
    [fields.map((field) => templates.examples[field] || "")],
  );
}
