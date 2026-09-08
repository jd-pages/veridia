import { describe, expect, it } from "vitest";
import { BUILTIN_IMPORT_EXPORT_TEMPLATES as templates } from "@/lib/import-export-templates/config";
import { parseTabularPreview } from "@/lib/import-export-templates/tabular";
import { buildImportCsv, buildImportXlsx } from "../helpers/import-row-limit";

const boundaries = [4999, 5000, 5001, 5005, 5100] as const;

async function outcome(source: "CSV" | "EXCEL_XLSX", inputRows: number, blankEvery = 0) {
  const bytes = source === "CSV"
    ? buildImportCsv(inputRows, blankEvery)
    : await buildImportXlsx(inputRows, blankEvery);
  try {
    const result = await parseTabularPreview({
      bytes,
      fileName: source === "CSV" ? "边界.csv" : "边界.xlsx",
      sourceType: source,
      templates,
    });
    return { status: "RESOLVED", total: result.total, validCount: result.validCount };
  } catch (error) {
    return {
      status: "REJECTED",
      name: error instanceof Error ? error.name : "Unknown",
      message: error instanceof Error ? error.message : String(error),
      code: error && typeof error === "object" && "code" in error ? error.code : null,
    };
  }
}

describe.each(["CSV", "EXCEL_XLSX"] as const)("A10 %s row limit", (source) => {
  it.each(boundaries)("handles %i non-empty data rows without silent truncation", async (inputRows) => {
    const actual = await outcome(source, inputRows);
    if (inputRows <= templates.dataValidation.maxRows) {
      expect(actual).toEqual({ status: "RESOLVED", total: inputRows, validCount: inputRows });
    } else {
      expect(actual).toEqual({
        status: "REJECTED",
        name: "ImportRowLimitError",
        message: `导入文件包含 ${inputRows} 条非空数据，最多支持 ${templates.dataValidation.maxRows} 条；本次未导入任何数据。`,
        code: "IMPORT_ROW_LIMIT_EXCEEDED",
      });
    }
  }, 30_000);

  it("does not count blank physical rows against the 5000-record limit", async () => {
    await expect(outcome(source, 5000, 1000)).resolves.toEqual({
      status: "RESOLVED",
      total: 5000,
      validCount: 5000,
    });
  }, 30_000);
});
