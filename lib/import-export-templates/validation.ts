import { z } from "zod";
import {
  LOCAL_TABULAR_SOURCE_TYPES,
  TEMPLATE_SCHEMA_VERSION,
  type ImportExportTemplates,
} from "./types";

const nonEmpty = z.string().trim().min(1);
const fieldDefinition = z.object({
  displayName: nonEmpty,
  type: z.enum(["string", "url", "integer", "datetime", "stringList"]),
  description: z.string(),
});
const columnOrder = z.object({
  import: z.array(nonEmpty).min(1),
  auditResults: z.array(nonEmpty).min(1),
  auditTasks: z.array(nonEmpty).min(1),
});
const schema = z.object({
  schemaVersion: z.literal(TEMPLATE_SCHEMA_VERSION),
  templateVersion: nonEmpty,
  importTemplates: z.record(nonEmpty, z.object({
    sheetName: nonEmpty,
    headerRowSearchLimit: z.number().int().min(1).max(100),
    previewRowLimit: z.number().int().min(5).max(100),
    unknownFieldPolicy: z.enum(["IGNORE", "PRESERVE"]),
  })).refine((value) => Boolean(value.default), "缺少默认导入模板"),
  exportTemplates: z.record(nonEmpty, z.object({
    sheetName: nonEmpty,
    multiValueSeparator: z.string().min(1).max(4),
  })),
  fieldDefinitions: z.record(nonEmpty, fieldDefinition),
  fieldAliases: z.record(nonEmpty, z.array(nonEmpty).min(1)),
  requiredFields: z.array(nonEmpty).min(1),
  optionalFields: z.array(nonEmpty),
  columnOrder,
  dataValidation: z.object({
    maxFileBytes: z.number().int().positive(),
    maxRows: z.number().int().positive().max(100000),
    skipBlankRows: z.boolean(),
    trimWhitespace: z.boolean(),
    caseInsensitiveHeaders: z.boolean(),
  }),
  examples: z.record(z.string(), z.string()),
  compatibility: z.object({
    minimumAppVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/u),
    supportedTemplateSchemaVersions: z.array(z.number().int()).min(1),
  }),
  sourcePresets: z.record(nonEmpty, z.object({
    extensions: z.array(z.string().regex(/^\.[a-z0-9]+$/u)).min(1),
    localOnly: z.literal(true),
  })),
});

export function normalizeTemplateHeader(value: string) {
  return value
    .replace(/[＊*]\s*$/u, "")
    .replace(/[\u3000\s]+/gu, "")
    .trim()
    .toLocaleLowerCase("zh-CN");
}

export function validateImportExportTemplates(
  input: unknown,
): ImportExportTemplates {
  const value = schema.parse(input) as ImportExportTemplates;
  const fields = new Set(Object.keys(value.fieldDefinitions));
  for (const field of [
    ...value.requiredFields,
    ...value.optionalFields,
    ...value.columnOrder.import,
    ...value.columnOrder.auditResults,
    ...value.columnOrder.auditTasks,
  ]) {
    if (!fields.has(field)) {
      throw new Error(`模板字段未定义：${field}`);
    }
  }
  const aliasOwners = new Map<string, string>();
  for (const [field, aliases] of Object.entries(value.fieldAliases)) {
    if (!fields.has(field)) throw new Error(`字段别名引用未定义字段：${field}`);
    for (const alias of [
      value.fieldDefinitions[field].displayName,
      field,
      ...aliases,
    ]) {
      const normalized = normalizeTemplateHeader(alias);
      const owner = aliasOwners.get(normalized);
      if (owner && owner !== field) {
        throw new Error(`字段别名冲突：“${alias}”同时属于 ${owner} 和 ${field}`);
      }
      aliasOwners.set(normalized, field);
    }
  }
  for (const required of value.requiredFields) {
    if (!value.columnOrder.import.includes(required)) {
      throw new Error(`必填字段未进入导入列顺序：${required}`);
    }
  }
  for (const source of Object.keys(value.sourcePresets)) {
    if (!LOCAL_TABULAR_SOURCE_TYPES.includes(source as never)) {
      throw new Error(`不支持的数据源预设：${source}`);
    }
  }
  return value;
}
