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

type Matrix = string[][];

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

async function xlsxMatrix(bytes: Uint8Array): Promise<Matrix> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("无法读取表格：工作簿中没有工作表");
  const rows: Matrix = [];
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values: string[] = [];
    for (
      let columnNumber = 1;
      columnNumber <= Math.max(sheet.columnCount, row.cellCount);
      columnNumber += 1
    ) {
      values.push(excelCellText(row.getCell(columnNumber), true));
    }
    rows.push(values);
  }
  return rows;
}

function legacyExcelMatrix(bytes: Uint8Array): Matrix {
  const workbook = XLSX.read(bytes, { type: "array", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("无法读取表格：工作簿中没有工作表");
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
  }).map((row) => row.map((value) => String(value ?? "").trim()));
}

function aliasIndex(templates: ImportExportTemplates) {
  const aliases = new Map<string, StandardField>();
  for (const field of templates.columnOrder.import) {
    const definition = templates.fieldDefinitions[field];
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
) {
  return templates.fieldDefinitions[field]?.displayName || field;
}

export async function parseTabularPreview(input: {
  bytes: Uint8Array;
  fileName: string;
  sourceType: LocalTabularSourceType;
  templates: ImportExportTemplates;
}): Promise<TabularPreview> {
  const { bytes, sourceType, templates } = input;
  if (!bytes.byteLength) throw new Error("文件为空");
  if (bytes.byteLength > templates.dataValidation.maxFileBytes) {
    throw new Error(
      `文件不能超过${Math.round(templates.dataValidation.maxFileBytes / 1024 / 1024)}MB`,
    );
  }
  let matrix: Matrix;
  try {
    matrix =
      sourceType === "CSV" ||
      sourceType === "TENCENT_DOCS_EXPORTED_CSV"
        ? csvMatrix(bytes)
        : sourceType === "EXCEL_XLS"
          ? legacyExcelMatrix(bytes)
          : await xlsxMatrix(bytes);
  } catch (error) {
    if (error instanceof Error && /文件为空|编码|工作表/u.test(error.message)) {
      throw error;
    }
    throw new Error(
      `无法读取表格：${error instanceof Error ? error.message : "表格格式不支持"}`,
    );
  }
  const { rowIndex, aliases } = locateHeader(matrix, templates);
  const header = matrix[rowIndex];
  const recognizedFields: TabularPreview["recognizedFields"] = [];
  const unknownHeaders: string[] = [];
  const duplicateHeaders: string[] = [];
  const occupied = new Map<StandardField, string>();
  header.forEach((rawHeader, columnIndex) => {
    const value = rawHeader.trim();
    if (!value) return;
    const field = aliases.get(normalizeTemplateHeader(value));
    if (!field) {
      unknownHeaders.push(value);
      return;
    }
    if (occupied.has(field)) {
      duplicateHeaders.push(displayName(templates, field));
      return;
    }
    occupied.set(field, value);
    recognizedFields.push({
      column: columnIndex + 1,
      header: value,
      field,
    });
  });
  const missingRequiredFields = templates.requiredFields.filter(
    (field) => !occupied.has(field),
  );
  const structuralErrors = [
    ...missingRequiredFields.map(
      (field) => `缺少必填字段：${displayName(templates, field)}`,
    ),
    ...duplicateHeaders.map((field) => `表头重复：${field}`),
  ];
  const rows: TabularPreviewRow[] = [];
  const maxRow = Math.min(
    matrix.length,
    rowIndex + 1 + templates.dataValidation.maxRows,
  );
  for (let index = rowIndex + 1; index < maxRow; index += 1) {
    const sourceRow = matrix[index];
    if (!sourceRow.some((value) => value.trim())) continue;
    const values: TabularPreviewRow["values"] = {};
    for (const match of recognizedFields) {
      values[match.field] = String(sourceRow[match.column - 1] || "").trim();
    }
    const errors = [...structuralErrors];
    for (const field of templates.requiredFields) {
      if (!values[field]) {
        errors.push(`缺少必填字段：${displayName(templates, field)}`);
      }
    }
    rows.push({ rowNumber: index + 1, values, errors: [...new Set(errors)] });
  }
  if (!rows.length) throw new Error("未识别到有效数据行");
  const validCount = rows.filter((row) => row.errors.length === 0).length;
  return {
    templateVersion: templates.templateVersion,
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
