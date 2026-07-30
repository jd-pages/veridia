import ExcelJS from "exceljs";
import * as XLSX from "@e965/xlsx";
import { describe, expect, it } from "vitest";
import builtinTemplates from "@/rules/default-import-export-templates.json";
import {
  buildConfiguredCsv,
  buildConfiguredWorkbook,
  buildImportTemplateWorkbook,
} from "@/lib/import-export-templates/export";
import {
  detectLocalSourceType,
  parseTabularPreview,
} from "@/lib/import-export-templates/tabular";
import { validateImportExportTemplates } from "@/lib/import-export-templates/validation";

const templates = validateImportExportTemplates(builtinTemplates);

describe("远程表格模板配置", () => {
  it("内置模板包含必填字段、标准别名和本地数据源", () => {
    expect(templates.requiredFields).toEqual([
      "noteUrl",
      "productName",
      "activityName",
    ]);
    expect(templates.fieldAliases.noteUrl).toContain("小红书链接");
    expect(templates.sourcePresets.TENCENT_DOCS_EXPORTED_XLSX?.localOnly).toBe(
      true,
    );
  });

  it("拒绝必填字段缺失、列字段未定义和跨字段别名冲突", () => {
    const missing = structuredClone(builtinTemplates);
    missing.columnOrder.import = missing.columnOrder.import.filter(
      (field) => field !== "noteUrl",
    );
    expect(() => validateImportExportTemplates(missing)).toThrow(
      /必填字段未进入导入列顺序/u,
    );

    const unknown = structuredClone(builtinTemplates);
    unknown.columnOrder.auditResults.push("notAField" as never);
    expect(() => validateImportExportTemplates(unknown)).toThrow(
      /模板字段未定义/u,
    );

    const conflict = structuredClone(builtinTemplates);
    conflict.fieldAliases.productName.push("链接");
    expect(() => validateImportExportTemplates(conflict)).toThrow(
      /字段别名冲突/u,
    );
  });
});

describe("Excel、CSV与腾讯文档导出文件预览", () => {
  it("CSV支持BOM、别名、乱序、多余列和空行", async () => {
    const csv = [
      "\uFEFF活动名称,额外列,小红书链接,商品名称",
      "爱他美2026年7月小红书种草审核,忽略,https://xhslink.com/example,澳白",
      ",,,",
    ].join("\r\n");
    const result = await parseTabularPreview({
      bytes: Buffer.from(csv),
      fileName: "腾讯文档导出.csv",
      sourceType: "TENCENT_DOCS_EXPORTED_CSV",
      templates,
    });
    expect(result.validCount).toBe(1);
    expect(result.unknownHeaders).toEqual(["额外列"]);
    expect(result.previewRows[0].values).toMatchObject({
      noteUrl: "https://xhslink.com/example",
      productName: "澳白",
      activityName: "爱他美2026年7月小红书种草审核",
    });
  });

  it("Excel支持格式行、超链接、富文本和变化后的表头顺序", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("腾讯文档");
    sheet.addRow(["导出时间：2026-07-30"]);
    sheet.addRow(["商品", "活动", "链接", "标题"]);
    const row = sheet.addRow([
      "澳白",
      "爱他美2026年7月小红书种草审核",
      "",
      "",
    ]);
    row.getCell(3).value = {
      text: "打开笔记",
      hyperlink: "https://xhslink.com/hyperlink",
    };
    row.getCell(4).value = {
      richText: [{ text: "富文本" }, { text: "标题" }],
    };
    const result = await parseTabularPreview({
      bytes: new Uint8Array(await workbook.xlsx.writeBuffer()),
      fileName: "腾讯文档导出.xlsx",
      sourceType: "TENCENT_DOCS_EXPORTED_XLSX",
      templates,
    });
    expect(result.headerRowNumber).toBe(2);
    expect(result.previewRows[0].values.noteUrl).toBe(
      "https://xhslink.com/hyperlink",
    );
    expect(result.previewRows[0].values.title).toBe("富文本标题");
  });

  it("旧版 .xls 文件使用同一字段映射预览", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["链接", "商品", "活动名称"],
        [
          "https://xhslink.com/legacy-xls",
          "澳白",
          "爱他美2026年7月小红书种草审核",
        ],
      ]),
      "导入",
    );
    const bytes = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xls",
    }) as Buffer;
    const result = await parseTabularPreview({
      bytes,
      fileName: "legacy.xls",
      sourceType: "EXCEL_XLS",
      templates,
    });
    expect(result.validCount).toBe(1);
    expect(result.previewRows[0].values.noteUrl).toContain("legacy-xls");
  });

  it("清晰提示缺少必填字段、重复表头、空文件和乱码CSV", async () => {
    const missing = await parseTabularPreview({
      bytes: Buffer.from("产品,活动\r\n澳白,7月活动"),
      fileName: "missing.csv",
      sourceType: "CSV",
      templates,
    });
    expect(missing.missingRequiredFields).toContain("noteUrl");
    expect(missing.rows[0].errors).toContain("缺少必填字段：笔记链接");

    const duplicate = await parseTabularPreview({
      bytes: Buffer.from(
        "笔记链接,链接,产品,活动\r\nhttps://xhslink.com/a,https://xhslink.com/b,澳白,活动",
      ),
      fileName: "duplicate.csv",
      sourceType: "CSV",
      templates,
    });
    expect(duplicate.duplicateHeaders).toContain("笔记链接");

    await expect(
      parseTabularPreview({
        bytes: new Uint8Array(),
        fileName: "empty.csv",
        sourceType: "CSV",
        templates,
      }),
    ).rejects.toThrow("文件为空");
    await expect(
      parseTabularPreview({
        bytes: Buffer.from([0xef, 0xbf, 0xbd]),
        fileName: "bad.csv",
        sourceType: "CSV",
        templates,
      }),
    ).rejects.toThrow(/编码无法识别/u);
  });

  it("在线腾讯文档类型只有类型预留，本地检测不会产生在线类型", () => {
    expect(detectLocalSourceType("导出.xlsx", true)).toBe(
      "TENCENT_DOCS_EXPORTED_XLSX",
    );
    expect(detectLocalSourceType("导出.csv", true)).toBe(
      "TENCENT_DOCS_EXPORTED_CSV",
    );
  });
});

describe("模板驱动导出", () => {
  it("下载模板含说明页、必填标记和模板版本", async () => {
    const bytes = await buildImportTemplateWorkbook(templates);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "笔记导入",
      "填写说明",
    ]);
    expect(workbook.getWorksheet("笔记导入")?.getCell("A1").text).toContain(
      "*",
    );
    expect(workbook.getWorksheet("填写说明")?.getCell("B2").text).toBe(
      templates.templateVersion,
    );
  });

  it("Excel和CSV严格使用模板列顺序且CSV含UTF-8 BOM", async () => {
    const records = [
      {
        noteUrl: "https://xhslink.com/a",
        productName: "爱他美澳洲白金版",
        activityName: "7月活动",
        auditResult: "审核通过",
      },
    ];
    const csv = buildConfiguredCsv({
      templates,
      kind: "auditResults",
      records,
    });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split("\r\n")[0].split(",")[0]).toBe("笔记链接");

    const bytes = await buildConfiguredWorkbook({
      templates,
      kind: "auditResults",
      records,
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    expect(workbook.worksheets[0].getRow(1).getCell(1).text).toBe("笔记链接");
  });
});
