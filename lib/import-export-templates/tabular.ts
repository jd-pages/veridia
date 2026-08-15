import ExcelJS from "exceljs";
import * as XLSX from "@e965/xlsx";
import {
  type ImportExportTemplates,
  type LocalTabularSourceType,
  type StandardField,
  type TabularPreview,
  type TabularPreviewRow,
} from "./types";
import { normalizeTemplateHeader } from "./validation";
import {
  DANONE_BRAND_NAME,
  KABRITA_BRAND_NAME,
  KABRITA_FIELD_DEFINITIONS,
  KABRITA_REQUIRED_FIELDS,
  KABRITA_TEMPLATE_FIELDS,
  isKabritaTemplateHeader,
  kabritaDisplayName,
} from "./kabrita";
import {
  DANONE_AGENCY_IMPORT_FIELDS,
  DANONE_CUSTOMER_IMPORT_FIELDS,
  isImportTemplateType,
  type ImportTemplateType,
} from "@/lib/import-template-type";

type Matrix = string[][];
type ParsedMatrix = {
  matrix: Matrix;
  hyperlinks: Map<string, string>;
  templateType?: ImportTemplateType;
  performance: {
    excelParseMs: number;
    worksheetParseMs: number;
    worksheetRowCount: number;
    effectiveWorksheetRowCount: number;
    effectiveWorksheetColumnCount: number;
  };
};

export interface TabularParsePerformance {
  excelParseMs: number;
  worksheetParseMs: number;
  headerRecognitionMs: number;
  rowConversionMs: number;
  worksheetRowCount: number;
  effectiveWorksheetRowCount: number;
  effectiveWorksheetColumnCount: number;
}

const cellKey = (rowIndex: number, columnIndex: number) =>
  `${rowIndex}:${columnIndex}`;

const widestRow = (matrix: Matrix) =>
  matrix.reduce((maximum, row) => Math.max(maximum, row.length), 0);

function csvMatrix(bytes: Uint8Array): Matrix {
  const source = Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/u, "");
  if (source.includes("\uFFFD")) {
    throw new Error("CSV编码无法识别，请另存为UTF-8编码后重试");
  }
  if (!source.trim()) throw new Error("文件为空");
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }
  row.push(value);
  if (row.some(Boolean) || rows.length === 0) rows.push(row);
  return rows;
}

function excelCellText(cell: ExcelJS.Cell, preferHyperlink = false) {
  if (cell.value == null) return "";
  if (typeof cell.value === "object") {
    if ("hyperlink" in cell.value && preferHyperlink) {
      return String(cell.value.hyperlink || cell.value.text || "").trim();
    }
    if ("richText" in cell.value && Array.isArray(cell.value.richText)) {
      return cell.value.richText.map((item) => item.text || "").join("").trim();
    }
    if ("text" in cell.value) return String(cell.value.text || "").trim();
    if ("result" in cell.value && cell.value.result != null) {
      return String(cell.value.result).trim();
    }
  }
  if (cell.value instanceof Date) return cell.value.toISOString();
  return cell.text.trim();
}

async function xlsxMatrix(
  bytes: Uint8Array,
  maximumRelevantRows: number,
): Promise<ParsedMatrix> {
  const workbook = new ExcelJS.Workbook();
  const excelParseStarted = performance.now();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const excelParseMs = performance.now() - excelParseStarted;
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("无法读取表格：工作簿中没有工作表");
  const worksheetParseStarted = performance.now();
  const rows: Matrix = [];
  const hyperlinks = new Map<string, string>();
  let lastMeaningfulRow = 0;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (row.hasValues) lastMeaningfulRow = Math.max(lastMeaningfulRow, rowNumber);
  });
  const effectiveWorksheetRowCount = Math.min(
    lastMeaningfulRow,
    maximumRelevantRows,
  );
  let effectiveWorksheetColumnCount = 0;
  for (
    let rowNumber = 1;
    rowNumber <= effectiveWorksheetRowCount;
    rowNumber += 1
  ) {
    const row = sheet.getRow(rowNumber);
    const values: string[] = [];
    let lastMeaningfulColumn = 0;
    row.eachCell({ includeEmpty: false }, (_cell, columnNumber) => {
      lastMeaningfulColumn = Math.max(lastMeaningfulColumn, columnNumber);
    });
    effectiveWorksheetColumnCount = Math.max(
      effectiveWorksheetColumnCount,
      lastMeaningfulColumn,
    );
    for (let columnNumber = 1; columnNumber <= lastMeaningfulColumn; columnNumber += 1) {
      const cell = row.getCell(columnNumber);
      values.push(excelCellText(cell));
      if (
        cell.value &&
        typeof cell.value === "object" &&
        "hyperlink" in cell.value &&
        cell.value.hyperlink
      ) {
        hyperlinks.set(
          cellKey(rowNumber - 1, columnNumber - 1),
          String(cell.value.hyperlink).trim(),
        );
      }
    }
    rows.push(values);
  }
  const metadata = workbook.getWorksheet("VERIDIA模板信息");
  const metadataType = metadata?.getCell("B1").text.trim();
  return {
    matrix: rows,
    hyperlinks,
    templateType: isImportTemplateType(metadataType) ? metadataType : undefined,
    performance: {
      excelParseMs,
      worksheetParseMs: performance.now() - worksheetParseStarted,
      worksheetRowCount: sheet.rowCount,
      effectiveWorksheetRowCount,
      effectiveWorksheetColumnCount,
    },
  };
}

function legacyExcelMatrix(bytes: Uint8Array): ParsedMatrix {
  const excelParseStarted = performance.now();
  const workbook = XLSX.read(bytes, { type: "array", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("无法读取表格：工作簿中没有工作表");
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
  }).map((row) => row.map((value) => String(value ?? "").trim()));
  const hyperlinks = new Map<string, string>();
  const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : null;
  if (range) {
    for (let row = range.s.r; row <= range.e.r; row += 1) {
      for (let column = range.s.c; column <= range.e.c; column += 1) {
        const address = XLSX.utils.encode_cell({ r: row, c: column });
        const target = (sheet[address] as { l?: { Target?: string } } | undefined)
          ?.l?.Target;
        if (target) hyperlinks.set(cellKey(row, column), target.trim());
      }
    }
  }
  return {
    matrix,
    hyperlinks,
    performance: {
      excelParseMs: performance.now() - excelParseStarted,
      worksheetParseMs: 0,
      worksheetRowCount: matrix.length,
      effectiveWorksheetRowCount: matrix.length,
      effectiveWorksheetColumnCount: widestRow(matrix),
    },
  };
}

function aliasIndex(templates: ImportExportTemplates) {
  const aliases = new Map<string, StandardField>();
  const fields = new Set<StandardField>([
    ...templates.columnOrder.import,
    ...DANONE_CUSTOMER_IMPORT_FIELDS,
    ...DANONE_AGENCY_IMPORT_FIELDS,
    ...KABRITA_TEMPLATE_FIELDS,
    "complianceResult",
    // 兼容第三方表格使用“活动名称”；新版正式表头为“活动名称（必填）”。
    "activityName",
  ]);
  for (const field of fields) {
    const definition =
      KABRITA_FIELD_DEFINITIONS[
        field as keyof typeof KABRITA_FIELD_DEFINITIONS
      ] || templates.fieldDefinitions[field];
    if (!definition) continue;
    for (const alias of [
      field,
      definition.displayName,
      ...(templates.fieldAliases[field] || []),
    ]) {
      aliases.set(normalizeTemplateHeader(alias), field);
    }
  }
  return aliases;
}

function locateHeader(
  matrix: Matrix,
  templates: ImportExportTemplates,
) {
  const aliases = aliasIndex(templates);
  const limit = Math.min(
    matrix.length,
    templates.importTemplates.default.headerRowSearchLimit,
  );
  let best = { rowIndex: -1, count: 0 };
  for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
    const count = matrix[rowIndex].filter((value) =>
      aliases.has(normalizeTemplateHeader(value)),
    ).length;
    if (count > best.count) best = { rowIndex, count };
  }
  if (best.rowIndex < 0 || best.count === 0) {
    throw new Error("未识别到有效表头");
  }
  return { ...best, aliases };
}

function displayName(
  templates: ImportExportTemplates,
  field: string,
  kabritaTemplate = false,
) {
  if (kabritaTemplate) return kabritaDisplayName(field as StandardField);
  return templates.fieldDefinitions[field]?.displayName || field;
}

function detectTemplateType(
  header: readonly string[],
  metadataType?: ImportTemplateType,
): ImportTemplateType {
  if (metadataType) return metadataType;
  if (isKabritaTemplateHeader(header)) return "KABRITA";
  const normalized = new Set(header.map(normalizeTemplateHeader));
  const hasStage = normalized.has(normalizeTemplateHeader("阶段")) ||
    normalized.has(normalizeTemplateHeader("阶段（必填）"));
  return hasStage ? "DANONE_CUSTOMER" : "DANONE_AGENCY";
}

function templateField(
  rawHeader: string,
  fallback: StandardField | undefined,
  templateType: ImportTemplateType,
) {
  const normalized = normalizeTemplateHeader(rawHeader);
  if (templateType === "DANONE_CUSTOMER") {
    if (["阶段", "阶段（必填）"].map(normalizeTemplateHeader).includes(normalized)) {
      return "productStageDetail" as const;
    }
    if (["段位", "段位（必填）"].map(normalizeTemplateHeader).includes(normalized)) {
      return "productStage" as const;
    }
  }
  if (
    templateType === "DANONE_AGENCY" &&
    ["段位", "段位（必填）"].map(normalizeTemplateHeader).includes(normalized)
  ) {
    return "productStage" as const;
  }
  return fallback;
}

export async function parseTabularPreview(input: {
  bytes: Uint8Array;
  fileName: string;
  sourceType: LocalTabularSourceType;
  templates: ImportExportTemplates;
  onPerformance?: (performance: TabularParsePerformance) => void;
}): Promise<TabularPreview> {
  const { bytes, sourceType, templates } = input;
  if (!bytes.byteLength) throw new Error("文件为空");
  if (bytes.byteLength > templates.dataValidation.maxFileBytes) {
    throw new Error(
      `文件不能超过${Math.round(templates.dataValidation.maxFileBytes / 1024 / 1024)}MB`,
    );
  }
  let parsedMatrix: ParsedMatrix;
  try {
    parsedMatrix =
      sourceType === "CSV" ||
      sourceType === "TENCENT_DOCS_EXPORTED_CSV"
        ? (() => {
            const started = performance.now();
            const matrix = csvMatrix(bytes);
            return {
              matrix,
              hyperlinks: new Map<string, string>(),
              performance: {
                excelParseMs: performance.now() - started,
                worksheetParseMs: 0,
                worksheetRowCount: matrix.length,
                effectiveWorksheetRowCount: matrix.length,
                effectiveWorksheetColumnCount: widestRow(matrix),
              },
            };
          })()
        : sourceType === "EXCEL_XLS"
          ? legacyExcelMatrix(bytes)
          : await xlsxMatrix(
              bytes,
              templates.importTemplates.default.headerRowSearchLimit +
                templates.dataValidation.maxRows,
            );
  } catch (error) {
    if (error instanceof Error && /文件为空|编码|工作表/u.test(error.message)) {
      throw error;
    }
    throw new Error(
      `无法读取表格：${error instanceof Error ? error.message : "表格格式不支持"}`,
    );
  }
  const { matrix, hyperlinks: cellHyperlinks } = parsedMatrix;
  const headerRecognitionStarted = performance.now();
  const { rowIndex, aliases } = locateHeader(matrix, templates);
  const header = matrix[rowIndex];
  const templateType = detectTemplateType(header, parsedMatrix.templateType);
  const kabritaTemplate = templateType === "KABRITA";
  const recognizedFields: TabularPreview["recognizedFields"] = [];
  const unknownHeaders: string[] = [];
  const duplicateHeaders: string[] = [];
  const occupied = new Map<StandardField, string>();
  header.forEach((rawHeader, columnIndex) => {
    const value = rawHeader.trim();
    if (!value) return;
    const field = parsedMatrix.templateType
      ? templateField(
          value,
          aliases.get(normalizeTemplateHeader(value)),
          templateType,
        )
      : aliases.get(normalizeTemplateHeader(value));
    if (!field) {
      unknownHeaders.push(value);
      return;
    }
    if (occupied.has(field)) {
      duplicateHeaders.push(displayName(templates, field, kabritaTemplate));
      return;
    }
    occupied.set(field, value);
    recognizedFields.push({
      column: columnIndex + 1,
      header: value,
      field,
      displayName: displayName(templates, field, kabritaTemplate),
    });
  });
  if (
    !parsedMatrix.templateType &&
    !occupied.has("productStage") &&
    occupied.has("productStageDetail")
  ) {
    const legacyMatch = recognizedFields.find(
      (match) => match.field === "productStageDetail",
    );
    if (legacyMatch) {
      legacyMatch.field = "productStage";
      occupied.set("productStage", legacyMatch.header);
      occupied.delete("productStageDetail");
    }
  }
  const legacyLayout = !kabritaTemplate && !["customerName", "publishTime"].some(
    (field) => occupied.has(field as StandardField),
  );
  const requiredFields: StandardField[] = parsedMatrix.templateType
    ? kabritaTemplate
      ? [...KABRITA_REQUIRED_FIELDS]
      : templateType === "DANONE_AGENCY"
        ? [...DANONE_AGENCY_IMPORT_FIELDS]
        : [...DANONE_CUSTOMER_IMPORT_FIELDS]
    : kabritaTemplate
      ? [...KABRITA_REQUIRED_FIELDS]
      : legacyLayout
        ? ["noteUrl", "productName", "productStage", "activityName"]
        : templates.requiredFields;
  const missingRequiredFields = requiredFields.filter(
    (field) => !occupied.has(field),
  );
  const structuralErrors = [
    ...missingRequiredFields.map((field) =>
      field === "activityName"
        ? "当前模板缺少“活动名称（必填）”列，请下载最新版导入模板后重新填写"
        : `缺少必填字段：${displayName(templates, field, kabritaTemplate)}`,
    ),
    ...duplicateHeaders.map((field) => `表头重复：${field}`),
  ];
  const headerRecognitionMs = performance.now() - headerRecognitionStarted;
  const rowConversionStarted = performance.now();
  const rows: TabularPreviewRow[] = [];
  const maxRow = Math.min(
    matrix.length,
    rowIndex + 1 + templates.dataValidation.maxRows,
  );
  for (let index = rowIndex + 1; index < maxRow; index += 1) {
    const sourceRow = matrix[index];
    if (!sourceRow.some((value) => value.trim())) continue;
    const values: TabularPreviewRow["values"] = {};
    const rawValues: TabularPreviewRow["values"] = {};
    const hyperlinks: TabularPreviewRow["values"] = {};
    for (const match of recognizedFields) {
      const rawValue = String(sourceRow[match.column - 1] || "").trim();
      const hyperlink = cellHyperlinks.get(
        cellKey(index, match.column - 1),
      );
      rawValues[match.field] = rawValue;
      if (hyperlink) hyperlinks[match.field] = hyperlink;
      values[match.field] =
        (match.field === "noteUrl" ||
          match.field === "xiaohongshuPublishLink") &&
        hyperlink
          ? hyperlink
          : rawValue;
    }
    const errors = [...structuralErrors];
    for (const field of requiredFields) {
      if (!values[field]) {
        errors.push(
          field === "activityName"
            ? "活动名称不能为空"
            : field === "productStage"
              ? "段位不能为空"
              : field === "productStageDetail"
                ? "阶段不能为空"
            : `缺少必填字段：${displayName(templates, field, kabritaTemplate)}`,
        );
      }
    }
    rows.push({
      rowNumber: index + 1,
      values,
      rawValues,
      hyperlinks,
      errors: [...new Set(errors)],
    });
  }
  if (!rows.length) throw new Error("未识别到有效数据行");
  const rowConversionMs = performance.now() - rowConversionStarted;
  const validCount = rows.filter((row) => row.errors.length === 0).length;
  input.onPerformance?.({
    ...parsedMatrix.performance,
    headerRecognitionMs,
    rowConversionMs,
  });
  return {
    templateVersion: templates.templateVersion,
    templateBrand: kabritaTemplate
      ? KABRITA_BRAND_NAME
      : DANONE_BRAND_NAME,
    templateType,
    sourceLabel: kabritaTemplate
      ? `${KABRITA_BRAND_NAME} Excel`
      : templateType === "DANONE_AGENCY"
        ? "达能代发 Excel"
        : "达能客户 Excel",
    sourceType,
    headerRowNumber: rowIndex + 1,
    recognizedFields,
    unknownHeaders: [...new Set(unknownHeaders)],
    missingRequiredFields,
    duplicateHeaders: [...new Set(duplicateHeaders)],
    total: rows.length,
    validCount,
    invalidCount: rows.length - validCount,
    rows,
    previewRows: rows.slice(
      0,
      templates.importTemplates.default.previewRowLimit,
    ),
  };
}

export function detectLocalSourceType(
  fileName: string,
  declaredTencentExport = false,
): LocalTabularSourceType {
  const lower = fileName.toLocaleLowerCase();
  if (lower.endsWith(".csv")) {
    return declaredTencentExport ? "TENCENT_DOCS_EXPORTED_CSV" : "CSV";
  }
  if (lower.endsWith(".xlsx")) {
    return declaredTencentExport
      ? "TENCENT_DOCS_EXPORTED_XLSX"
      : "EXCEL_XLSX";
  }
  if (lower.endsWith(".xls")) return "EXCEL_XLS";
  throw new Error("表格格式不支持，请选择 .xlsx、.xls 或 .csv 文件");
}

export function utf8BomCsv(
  headers: string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
) {
  const escape = (value: unknown) => {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
  };
  return `\uFEFF${[headers, ...rows].map((row) => row.map(escape).join(",")).join("\r\n")}`;
}
