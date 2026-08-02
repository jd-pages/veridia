import ExcelJS from "exceljs";
import * as XLSX from "@e965/xlsx";
import { readFile } from "node:fs/promises";
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
import {
  IMPORT_TEMPLATE_FIELDS,
  RESULT_EXPORT_FIELDS,
} from "@/lib/import-export-templates/config";

const templates = validateImportExportTemplates(builtinTemplates);

describe("远程表格模板配置", () => {
  it("内置模板包含必填字段、标准别名和本地数据源", () => {
    expect(templates.requiredFields).toEqual([
      "noteUrl",
      "productName",
      "activityName",
      "productStage",
    ]);
    expect(templates.fieldAliases.noteUrl).toContain("小红书链接");
    expect(templates.sourcePresets.TENCENT_DOCS_EXPORTED_XLSX?.localOnly).toBe(
      true,
    );
    expect(templates.columnOrder.import).toEqual(IMPORT_TEMPLATE_FIELDS);
    expect(templates.columnOrder.auditResults).toEqual(RESULT_EXPORT_FIELDS);
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
      "\uFEFF活动名称,额外列,小红书链接,商品名称,产品阶段话题",
      "爱他美2026年7月小红书种草审核,忽略,https://xhslink.com/example,澳白,IFFO",
      ",,,,,",
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
    sheet.addRow([
      "商品",
      "活动",
      "链接",
      "标题",
      "内容渠道",
      "产品阶段话题",
    ]);
    const row = sheet.addRow([
      "澳白",
      "爱他美2026年7月小红书种草审核",
      "",
      "",
      "小红书",
      "GUM",
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
    expect(result.previewRows[0].rawValues?.noteUrl).toBe("打开笔记");
    expect(result.previewRows[0].hyperlinks?.noteUrl).toBe(
      "https://xhslink.com/hyperlink",
    );
    expect(result.previewRows[0].values.contentChannel).toBeUndefined();
    expect(result.previewRows[0].values.title).toBeUndefined();
    expect(result.unknownHeaders).toEqual(
      expect.arrayContaining(["标题", "内容渠道"]),
    );
  });

  it("旧版 .xls 文件使用同一字段映射预览", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["链接", "商品", "活动名称", "产品阶段话题"],
        [
          "https://xhslink.com/legacy-xls",
          "澳白",
          "爱他美2026年7月小红书种草审核",
          "IFFO",
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

    const blankLink = await parseTabularPreview({
      bytes: Buffer.from(
        "笔记链接,产品,活动,产品阶段话题\r\n,澳白,7月活动,IFFO",
      ),
      fileName: "blank-link.csv",
      sourceType: "CSV",
      templates,
    });
    expect(blankLink.rows[0].errors).toContain("缺少必填字段：笔记链接");

    const duplicate = await parseTabularPreview({
      bytes: Buffer.from(
        "笔记链接,链接,产品,活动,产品阶段话题\r\nhttps://xhslink.com/a,https://xhslink.com/b,澳白,活动,IFFO",
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
    const headerValues = (workbook.getWorksheet("笔记导入")?.getRow(1)
      .values || []) as unknown[];
    const headers = headerValues.slice(1).map(String);
    expect(headers).toEqual([
      "笔记链接 *",
      "产品 *",
      "活动 *",
      "产品阶段话题 *",
    ]);
    const stageCell = workbook.getWorksheet("笔记导入")?.getCell("D2");
    expect(stageCell?.text).toBe("IFFO");
    expect(stageCell?.dataValidation).toMatchObject({
      type: "list",
      formulae: ['"IFFO,GUM"'],
      error: "产品阶段话题请填写 IFFO 或 GUM。",
    });
    for (const removed of [
      "内容渠道",
      "产品编码",
      "规格",
      "活动月份",
      "达人昵称",
      "发布时间",
      "标题",
      "正文内容",
      "图片数量",
      "话题标签",
      "截图状态",
      "缺图状态",
      "笔记状态",
      "备注",
    ]) {
      expect(headers.some((header) => header.includes(removed))).toBe(false);
    }
  });

  it("仓库内标准模板只展示 IFFO / GUM 并保留精简列", async () => {
    const noteWorkbook = new ExcelJS.Workbook();
    await noteWorkbook.xlsx.load(
      (await readFile("templates/笔记导入模板.xlsx")) as unknown as ExcelJS.Buffer,
    );
    const noteSheet = noteWorkbook.worksheets[0];
    expect((noteSheet.getRow(1).values as unknown[]).slice(1)).toEqual([
      "笔记链接 *",
      "产品 *",
      "活动 *",
      "产品阶段话题 *",
    ]);
    expect(noteSheet.getCell("D2").text).toBe("IFFO");
    expect(noteSheet.getCell("D2").dataValidation).toMatchObject({
      type: "list",
      formulae: ['"IFFO,GUM"'],
    });

    const ruleWorkbook = new ExcelJS.Workbook();
    await ruleWorkbook.xlsx.load(
      (await readFile(
        "templates/活动规则标准导入模板.xlsx",
      )) as unknown as ExcelJS.Buffer,
    );
    const ruleSheet = ruleWorkbook.getWorksheet("话题规则")!;
    expect(["C8", "C9", "C10"].map((cell) => ruleSheet.getCell(cell).text)).toEqual([
      "IFFO",
      "IFFO",
      "GUM",
    ]);
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
    expect(csv.slice(1).split("\r\n")[0].split(",")[0]).toBe("产品");

    const bytes = await buildConfiguredWorkbook({
      templates,
      kind: "auditResults",
      records,
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    expect(workbook.worksheets[0].getRow(1).getCell(1).text).toBe("产品");
  });

  it("18条当前筛选结果生成18条数据行且包含运营必需字段", async () => {
    const records = Array.from({ length: 18 }, (_, index) => ({
      noteUrl: `https://www.xiaohongshu.com/explore/export-${index + 1}`,
      noteId: `export-${index + 1}`,
      productName: "爱他美澳洲白金版",
      activityName: "爱他美2026年7月小红书种草审核",
      productStageTopic: "IFFO",
      requiredStageTopic: "#爱他美新手爸妈日记",
      topicsAuditResult: "合规",
      imageCount: 2,
      finalAuditConclusion: "审核通过",
      manualReviewStatus: "无需复核",
      failedReasons: "",
      effectiveBodyLength: 120,
      publicStatus: "当前公开",
      content: "示例正文",
    }));
    const bytes = await buildConfiguredWorkbook({
      templates,
      kind: "auditResults",
      records,
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    const sheet = workbook.worksheets[0];
    expect(sheet.rowCount).toBe(19);
    const headers = sheet.getRow(1).values as unknown[];
    expect(headers.slice(1)).toEqual([
      "产品",
      "活动",
      "产品阶段话题",
      "要求阶段话题",
      "最终审核结论",
      "人工复核状态",
      "失败原因",
      "正文有效字数",
      "图片数量",
      "话题审核结果",
      "当前公开状态",
      "正文内容",
    ]);
    expect(sheet.getColumn(headers.indexOf("产品")).values).toContain(
      "爱他美澳洲白金版",
    );
    for (const removed of [
      "异常分类",
      "笔记链接",
      "最终链接",
      "笔记ID",
      "任务来源",
      "正文允许段位",
      "正文实际识别段位",
      "达人昵称",
      "发布时间",
      "标题",
      "图片数量合规",
      "图片提取状态",
      "规则版本",
      "命中规则",
      "审核创建时间",
      "审核完成时间",
      "审核时间",
      "页面状态",
    ]) {
      expect(headers).not.toContain(removed);
    }
    expect(new Uint8Array(bytes as ArrayBuffer).byteLength).toBeGreaterThan(
      1_024,
    );
  });
});
