import { describe, expect, it } from "vitest";
import { selectImportPreviewRows } from "@/lib/import-preview";

describe("导入预检查展示数据", () => {
  it("分别保留原始顺序的全部预览与异常预览", () => {
    const rows = Array.from({ length: 250 }, (_, index) => ({
      rowNumber: index + 2,
      errors: index === 199 ? ["活动名称不能为空"] : [],
    }));

    const result = selectImportPreviewRows(rows, 100);

    expect(result.rows).toHaveLength(100);
    expect(result.rows[0].rowNumber).toBe(2);
    expect(result.errorRows).toEqual([
      { rowNumber: 201, errors: ["活动名称不能为空"] },
    ]);
    expect(result.rowsTruncated).toBe(true);
    expect(result.errorRowsTruncated).toBe(false);
  });

  it("异常超过上限时明确标记异常预览已截断", () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({
      rowNumber: index + 2,
      errors: ["异常"],
    }));

    const result = selectImportPreviewRows(rows, 100);

    expect(result.errorRows).toHaveLength(100);
    expect(result.errorRowsTruncated).toBe(true);
  });
});
