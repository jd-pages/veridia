import ExcelJS from "exceljs";
import * as XLSX from "@e965/xlsx";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import builtinTemplates from "@/rules/default-import-export-templates.json";
import {
  auditResultToExportRecord,
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
import {
  buildImportedTaskNotes,
  importedTaskMetadataFromNotes,
} from "@/lib/import-task-metadata";

const templates = validateImportExportTemplates(builtinTemplates);

describe("远程表格模板配置", () => {
  it("内置模板包含必填字段、标准别名和本地数据源", () => {
    expect(templates.requiredFields).toEqual([
      "platform",
      "shopName",
      "customerName",
      "productName",
      "productStage",
      "orderNumber",
      "contentChannel",
      "noteUrl",
      "publishTime",
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
    expect(result.previewRows[0].values.contentChannel).toBe("小红书");
    expect(result.previewRows[0].values.title).toBeUndefined();
    expect(result.unknownHeaders).toEqual(
      expect.arrayContaining(["标题"]),
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

  it("新九列表格读取人工识别字段并继续识别小红书短链接", async () => {
    const csv = [
      "平台（必填）,店铺名称（必填）,客户名（必填）,产品系列（必填）,阶段（IFFO/GUM）,订单编号（必填）,内容渠道（必填）,链接（必填）,发帖时间（必填）",
      "小红书,示例店铺,示例客户,爱他美奇迹绿罐,IFFO,ORDER-1001,小红书,https://xhslink.com/new-template,2026-08-03 12:00:00",
    ].join("\r\n");
    const result = await parseTabularPreview({
      bytes: Buffer.from(csv),
      fileName: "笔记导入.csv",
      sourceType: "CSV",
      templates,
    });
    expect(result.validCount).toBe(1);
    expect(result.previewRows[0].errors).toEqual([]);
    expect(result.previewRows[0].values).toMatchObject({
      productName: "爱他美奇迹绿罐",
      productStage: "IFFO",
      platform: "小红书",
      shopName: "示例店铺",
      customerName: "示例客户",
      orderNumber: "ORDER-1001",
      contentChannel: "小红书",
      noteUrl: "https://xhslink.com/new-template",
      publishTime: "2026-08-03 12:00:00",
    });
    expect(
      importedTaskMetadataFromNotes(
        buildImportedTaskNotes(result.previewRows[0].values),
      ),
    ).toMatchObject({
      platform: "小红书",
      shopName: "示例店铺",
      customerName: "示例客户",
      orderNumber: "ORDER-1001",
      contentChannel: "小红书",
      publishTime: "2026-08-03 12:00:00",
    });

    const missingOrder = await parseTabularPreview({
      bytes: Buffer.from(csv.replace("ORDER-1001", "")),
      fileName: "订单为空.csv",
      sourceType: "CSV",
      templates,
    });
    expect(missingOrder.validCount).toBe(0);
    expect(missingOrder.rows[0].errors).toContain(
      "缺少必填字段：订单编号（必填）",
    );
  });

  it("清晰提示缺少必填字段、重复表头、空文件和乱码CSV", async () => {
    const missing = await parseTabularPreview({
      bytes: Buffer.from("产品,活动\r\n澳白,7月活动"),
      fileName: "missing.csv",
      sourceType: "CSV",
      templates,
    });
    expect(missing.missingRequiredFields).toContain("noteUrl");
    expect(missing.rows[0].errors).toContain(
      "缺少必填字段：链接（必填）",
    );

    const blankLink = await parseTabularPreview({
      bytes: Buffer.from(
        "笔记链接,产品,活动,产品阶段话题\r\n,澳白,7月活动,IFFO",
      ),
      fileName: "blank-link.csv",
      sourceType: "CSV",
      templates,
    });
    expect(blankLink.rows[0].errors).toContain(
      "缺少必填字段：链接（必填）",
    );

    const duplicate = await parseTabularPreview({
      bytes: Buffer.from(
        "笔记链接,链接,产品,活动,产品阶段话题\r\nhttps://xhslink.com/a,https://xhslink.com/b,澳白,活动,IFFO",
      ),
      fileName: "duplicate.csv",
      sourceType: "CSV",
      templates,
    });
    expect(duplicate.duplicateHeaders).toContain("链接（必填）");

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
  it("下载模板按线下表格顺序生成九列并保留筛选和模板版本", async () => {
    const bytes = await buildImportTemplateWorkbook(templates);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "笔记导入",
      "填写说明",
    ]);
    expect(workbook.getWorksheet("笔记导入")?.getCell("A1").text).toBe(
      "平台（必填）",
    );
    expect(workbook.getWorksheet("填写说明")?.getCell("B2").text).toBe(
      templates.templateVersion,
    );
    const headerValues = (workbook.getWorksheet("笔记导入")?.getRow(1)
      .values || []) as unknown[];
    const headers = headerValues.slice(1).map(String);
    expect(headers).toEqual([
      "平台（必填）",
      "店铺名称（必填）",
      "客户名（必填）",
      "产品系列（必填）",
      "阶段（IFFO/GUM）",
      "订单编号（必填）",
      "内容渠道（必填）",
      "链接（必填）",
      "发帖时间（必填）",
    ]);
    const stageCell = workbook.getWorksheet("笔记导入")?.getCell("E2");
    expect(stageCell?.text).toBe("IFFO");
    expect(stageCell?.dataValidation).toMatchObject({
      type: "list",
      formulae: ['"IFFO,GUM"'],
      error: "产品阶段话题请填写 IFFO 或 GUM。",
    });
    expect(workbook.getWorksheet("笔记导入")?.getCell("G2").text).toBe(
      "小红书",
    );
    expect(workbook.getWorksheet("笔记导入")?.getColumn(9).numFmt).toBe(
      "yyyy-mm-dd hh:mm:ss",
    );
    expect(workbook.getWorksheet("笔记导入")?.autoFilter).toBeTruthy();
    expect(workbook.getWorksheet("笔记导入")?.getCell("A1").fill).toMatchObject({
      fgColor: { argb: "FFFFFF00" },
    });
    for (const removed of [
      "产品编码",
      "规格",
      "活动月份",
      "达人昵称",
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

  it("仓库内标准模板同步九列、筛选和 IFFO / GUM 校验", async () => {
    const noteWorkbook = new ExcelJS.Workbook();
    await noteWorkbook.xlsx.load(
      (await readFile("templates/笔记导入模板.xlsx")) as unknown as ExcelJS.Buffer,
    );
    const noteSheet = noteWorkbook.worksheets[0];
    expect((noteSheet.getRow(1).values as unknown[]).slice(1)).toEqual([
      "平台（必填）",
      "店铺名称（必填）",
      "客户名（必填）",
      "产品系列（必填）",
      "阶段（IFFO/GUM）",
      "订单编号（必填）",
      "内容渠道（必填）",
      "链接（必填）",
      "发帖时间（必填）",
    ]);
    expect(noteSheet.getCell("E2").text).toBe("IFFO");
    expect(noteSheet.getCell("E2").dataValidation).toMatchObject({
      type: "list",
      formulae: ['"IFFO,GUM"'],
    });
    expect(noteSheet.getCell("G2").text).toBe("小红书");
    expect(noteSheet.getColumn(9).numFmt).toBe("yyyy-mm-dd hh:mm:ss");
    expect(Boolean(noteSheet.autoFilter) || noteSheet.getTables().length > 0).toBe(
      true,
    );

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
    expect(csv.slice(1).split("\r\n")[0].split(",")[0]).toBe("平台");

    const bytes = await buildConfiguredWorkbook({
      templates,
      kind: "auditResults",
      records,
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    expect(workbook.worksheets[0].getRow(1).getCell(1).text).toBe(
      "平台",
    );
  });

  it("自审按通过、笔记不存在和图片异常映射且订单编号不参与审核", () => {
    const baseRow: Parameters<typeof auditResultToExportRecord>[0] = {
      autoStatus: "PASSED",
      pageStatus: "NORMAL",
      bodyStatus: "PRESENT",
      topicsCompliant: true,
      failureReasons: "[]",
      ruleVersion: 1,
      rulePackageVersion: null,
      ruleSnapshot: "{}",
      createdAt: new Date("2026-08-03T08:00:00.000Z"),
      auditedAt: new Date("2026-08-03T08:05:00.000Z"),
      effectiveBodyLength: 100,
      imageCount: 2,
      imageExtractionStatus: "SUCCESS",
      imageStatus: "COMPLIANT",
      publicStatus: "PUBLIC",
      task: {
        url: "https://xhslink.com/original",
        finalUrl: "https://www.xiaohongshu.com/explore/final",
        status: "COMPLETED",
        source: "EXCEL",
        attempts: 1,
        failureCode: null,
        failureMessage: null,
        pageTitle: "正常笔记",
        pageType: "NOTE_DETAIL",
        createdAt: new Date("2026-08-03T08:00:00.000Z"),
        productStage: "IFFO",
        notes: buildImportedTaskNotes({
          platform: "小红书",
          shopName: "示例店铺",
          customerName: "示例客户",
          orderNumber: "ORDER-1001",
          contentChannel: "小红书",
          publishTime: "2026-08-03 12:00:00",
        }),
        product: { name: "爱他美奇迹绿罐" },
        campaign: { name: "爱他美2026年7月小红书种草审核" },
      },
      note: {
        url: "https://xhslink.com/original",
        finalUrl: "https://www.xiaohongshu.com/explore/final",
        platformNoteId: "final",
        authorName: "示例达人",
        publishedAt: null,
        title: "正常笔记",
        body: "正常正文",
        topics: [],
      },
      ruleResults: [],
      manualReviews: [],
    };
    const passed = auditResultToExportRecord(baseRow, templates);
    expect(passed.selfReview).toBe("Y");
    expect(passed.orderNumber).toBe("ORDER-1001");
    expect(passed).toMatchObject({
      platform: "小红书",
      shopName: "示例店铺",
      customerName: "示例客户",
      contentChannel: "小红书",
    });
    expect(passed.publishTime).toEqual(
      new Date(Date.UTC(2026, 7, 3, 12, 0, 0)),
    );

    const unavailable = auditResultToExportRecord(
      {
        ...baseRow,
        autoStatus: "NEEDS_REVIEW",
        pageStatus: "NOT_FOUND",
        failureReasons: '["页面不存在"]',
        task: {
          ...baseRow.task,
          status: "READ_FAILED",
          failureCode: "PAGE_NOT_FOUND",
          failureMessage: "你访问的页面不见了",
        },
      },
      templates,
    );
    expect(unavailable.selfReview).toBe("N-帖子无法查看");
    expect(unavailable.finalAuditConclusion).toBe("笔记不存在");
    expect(unavailable.topicsAuditResult).toBe("无");
    expect(unavailable.imageStatus).toBe("无");

    const imageProblem = auditResultToExportRecord(
      {
        ...baseRow,
        autoStatus: "FAILED",
        imageCount: 1,
        imageStatus: "NON_COMPLIANT",
        failureReasons: '["图片数量不足（1/2）"]',
      },
      templates,
    );
    expect(imageProblem.selfReview).toBe("N-图片看不到奶粉段数");

    const otherFailure = auditResultToExportRecord(
      {
        ...baseRow,
        autoStatus: "FAILED",
        topicsCompliant: false,
        failureReasons: '["缺少精准话题"]',
      },
      templates,
    );
    expect(otherFailure.selfReview).toBe("");
  });

  it("18条当前筛选结果严格生成十列线下处理字段", async () => {
    const records = Array.from({ length: 18 }, (_, index) => ({
      platform: "小红书",
      shopName: "示例店铺",
      customerName: "示例客户",
      productName: "爱他美澳洲白金版",
      productStageTopic: "IFFO",
      orderNumber: `ORDER-${index + 1}`,
      contentChannel: "小红书",
      originalUrl: `https://www.xiaohongshu.com/explore/export-${index + 1}`,
      publishTime: new Date(Date.UTC(2026, 7, 3, 12, 0, 0)),
      selfReview: "Y",
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
      "平台",
      "店铺名称",
      "客户名",
      "产品系列",
      "阶段",
      "订单编号",
      "内容渠道",
      "链接",
      "发帖时间",
      "自审",
    ]);
    expect(sheet.getColumn(9).numFmt).toBe("yyyy-mm-dd hh:mm:ss");
    expect(sheet.getColumn(8).alignment?.wrapText).toBe(true);
    expect(sheet.getColumn(headers.indexOf("产品系列")).values).toContain(
      "爱他美澳洲白金版",
    );
    expect(sheet.getCell("J2").dataValidation).toMatchObject({
      type: "list",
      allowBlank: true,
      formulae: ['"Y,N-帖子无法查看,N-图片看不到奶粉段数"'],
    });
    expect(sheet.autoFilter).toBeTruthy();
    expect(sheet.getCell("A1").fill).toMatchObject({
      fgColor: { argb: "FFFFFF00" },
    });
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
      "图片数量合规",
      "图片提取状态",
      "规则版本",
      "命中规则",
      "审核创建时间",
      "审核完成时间",
      "页面状态",
      "笔记状态",
      "话题审核",
      "图片",
      "审核结论",
      "失败原因",
      "客服修改留言 日期-已留言",
      "审核时间",
      "正文",
      "正文内容",
      "笔记正文",
      "原文正文",
      "提取正文",
      "noteContent",
      "contentText",
    ]) {
      expect(headers).not.toContain(removed);
    }
    expect(new Uint8Array(bytes as ArrayBuffer).byteLength).toBeGreaterThan(
      1_024,
    );
  });
});
