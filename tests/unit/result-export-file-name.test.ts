import { describe, expect, it } from "vitest";
import {
  auditResultExportFileName,
  formatLocalExportTimestamp,
} from "../../lib/result-export-file-name";

describe("审核结果导出文件名", () => {
  const localDate = new Date(2026, 7, 4, 13, 48, 30);

  it("使用本地时间生成 Windows 安全的 YYYYMMDD_HHmmss", () => {
    expect(formatLocalExportTimestamp(localDate)).toBe("20260804_134830");
  });

  it("区分当前筛选与所选结果", () => {
    expect(auditResultExportFileName({ date: localDate })).toBe(
      "VERIDIA审核结果_当前筛选_20260804_134830.xlsx",
    );
    expect(
      auditResultExportFileName({ date: localDate, selected: true }),
    ).toBe("VERIDIA审核结果_所选结果_20260804_134830.xlsx");
  });

  it("佳贝艾特导出同样包含秒级时间戳", () => {
    expect(
      auditResultExportFileName({
        date: localDate,
        kabrita: true,
        extension: "csv",
      }),
    ).toBe("VERIDIA佳贝艾特审核结果_当前筛选_20260804_134830.csv");
  });

  it("按导入批次导出时包含安全的原文件名、导入时间和导出时间", () => {
    expect(
      auditResultExportFileName({
        date: localDate,
        importBatch: {
          fileName: "D1 7.25 小红书(1):终稿?.xlsx",
          createdAt: new Date(2026, 7, 6, 11, 45, 11),
        },
      }),
    ).toBe(
      "审核结果_D1 7.25 小红书(1)_终稿__20260806-114511_20260804-134830.xlsx",
    );
  });

  it("导出所选保持既有命名且不套用导入批次范围", () => {
    expect(
      auditResultExportFileName({
        date: localDate,
        selected: true,
        importBatch: {
          fileName: "来源.xlsx",
          createdAt: localDate,
        },
      }),
    ).toBe("VERIDIA审核结果_所选结果_20260804_134830.xlsx");
  });
});
