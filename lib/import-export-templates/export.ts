import ExcelJS from "exceljs";
import {
  businessFailureReasonLabel,
  businessSourceLabel,
  businessStatusLabel,
} from "@/lib/zh-CN";
import {
  allowedBodyStageLabels,
  detectBodyProductStages,
  productStageTopicLabel,
  stageTopicFromRuleSnapshot,
} from "@/lib/product-stage";
import type { ImportExportTemplates, StandardField } from "./types";
import { utf8BomCsv } from "./tabular";

export type ExportValueRecord = Partial<Record<StandardField, unknown>>;

function columns(
  templates: ImportExportTemplates,
  kind: keyof ImportExportTemplates["columnOrder"],
) {
  return templates.columnOrder[kind].map((field) => ({
    field,
    displayName: templates.fieldDefinitions[field].displayName,
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
  failureReasons: string;
  ruleVersion: number;
  rulePackageVersion: string | null;
  ruleSnapshot: string;
  auditedAt: Date;
  imageCount: number;
  imageExtractionStatus: string;
  imageStatus: string;
  task: {
    status: string;
    source: string;
    productStage: string | null;
    notes: string | null;
    product: { name: string };
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
}, templates: ImportExportTemplates): ExportValueRecord {
  const separator =
    templates.exportTemplates.auditResults?.multiValueSeparator || "、";
  const manual = row.manualReviews[0];
  const bodyStage = detectBodyProductStages(
    row.note.body,
    row.task.productStage,
  );
  return {
    noteUrl: row.note.finalUrl || row.note.url,
    noteId: row.note.platformNoteId,
    productName: row.task.product.name,
    activityName: row.task.campaign.name,
    source: businessSourceLabel(row.task.source),
    productStageTopic: productStageTopicLabel(row.task.productStage),
    allowedBodyStages: allowedBodyStageLabels(row.task.productStage).join(
      separator,
    ),
    detectedBodyStages:
      bodyStage?.detectedStages.join(separator) || "段位未识别",
    requiredStageTopic: stageTopicFromRuleSnapshot(row.ruleSnapshot) || "",
    influencerName: row.note.authorName,
    publishTime: row.note.publishedAt,
    title: row.note.title,
    content: row.note.body,
    imageCount: row.imageCount,
    imageExtractionStatus: businessStatusLabel(
      row.imageExtractionStatus,
    ),
    imageStatus: businessStatusLabel(row.imageStatus),
    topicTags: row.note.topics
      .map((topic) => topic.displayText)
      .join(separator),
    auditStatus: businessStatusLabel(row.task.status, "process"),
    auditResult: businessStatusLabel(
      manual?.result || row.autoStatus,
      "audit",
    ),
    failedReasons: list(row.failureReasons, separator),
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
  sheet.columns = selected.map(({ field, displayName }) => ({
    header: displayName,
    key: field,
    width: Math.min(60, Math.max(14, displayName.length * 3)),
  }));
  for (const record of records) {
    sheet.addRow(
      Object.fromEntries(
        selected.map(({ field }) => {
          const value = record[field];
          return [
            field,
            value instanceof Date
              ? value.toLocaleString("zh-CN", { hour12: false })
              : value ?? "",
          ];
        }),
      ),
    );
  }
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF163C85" },
  };
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
          ? value.toLocaleString("zh-CN", { hour12: false })
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
  sheet.columns = fields.map((field) => ({
    header: `${templates.fieldDefinitions[field].displayName}${
      templates.requiredFields.includes(field) ? " *" : ""
    }`,
    key: field,
    width: Math.min(
      52,
      Math.max(14, templates.fieldDefinitions[field].displayName.length * 3),
    ),
  }));
  sheet.addRow(
    Object.fromEntries(
      fields.map((field) => [field, templates.examples[field] || ""]),
    ),
  );
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF163C85" },
  };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

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
    fields.map(
      (field) =>
        `${templates.fieldDefinitions[field].displayName}${
          templates.requiredFields.includes(field) ? " *" : ""
        }`,
    ),
    [fields.map((field) => templates.examples[field] || "")],
  );
}
