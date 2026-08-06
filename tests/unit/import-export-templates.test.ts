import ExcelJS from "exceljs";
import * as XLSX from "@e965/xlsx";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import builtinTemplates from "@/rules/default-import-export-templates.json";
import {
  auditResultToCompactExportRecord,
  auditResultToExportRecord,
  auditResultToKabritaExportRecord,
  buildConfiguredCsv,
  buildConfiguredWorkbook,
  buildImportTemplateCsv,
  buildImportTemplateWorkbook,
} from "@/lib/import-export-templates/export";
import {
  detectLocalSourceType,
  parseTabularPreview,
} from "@/lib/import-export-templates/tabular";
import { validateImportExportTemplates } from "@/lib/import-export-templates/validation";
import {
  BUILTIN_IMPORT_EXPORT_TEMPLATES,
  IMPORT_TEMPLATE_FIELDS,
  RESULT_EXPORT_FIELDS,
} from "@/lib/import-export-templates/config";
import {
  buildImportedTaskNotes,
  importedTaskMetadataFromNotes,
  importedTemplateMetadataFromNotes,
} from "@/lib/import-task-metadata";
import {
  KABRITA_BRAND_NAME,
  KABRITA_EXPORT_FIELDS,
  KABRITA_IMPORT_FIELDS,
} from "@/lib/import-export-templates/kabrita";

const templates = BUILTIN_IMPORT_EXPORT_TEMPLATES;

const kabritaImportHeaders = [
  "登记时间",
  "渠道",
  "店铺名称",
  "客户备注",
  "买家购买ID",
  "购买订单号",
  "购买时间",
  "购买罐数",
  "参与次数",
  "发布小红书账号",
  "小红书发布链接",
  "购买产品线",
  "活动名称（必填）",
];

const kabritaExportHeaders = [
  ...kabritaImportHeaders.slice(0, -1),
  "活动名称",
  "自审",
];

describe("远程表格模板配置", () => {
  it("内置模板包含必填字段、标准别名和本地数据源", () => {
    expect(templates.requiredFields).toEqual([
      "shopName",
      "customerName",
      "noteUrl",
      "productName",
      "productStage",
      "publishTime",
      "activityName",
    ]);
    expect(templates.optionalFields).toContain("orderNumber");
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

describe("佳贝艾特专属导入导出模板", () => {
  it("严格生成不含是否符合的13列表头并可识别模板品牌", async () => {
    const bytes = await buildImportTemplateWorkbook(templates, {
      templateBrand: KABRITA_BRAND_NAME,
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    expect(
      (workbook.worksheets[0].getRow(1).values as unknown[]).slice(1),
    ).toEqual(kabritaImportHeaders);
    expect(KABRITA_IMPORT_FIELDS).toHaveLength(13);

    const csv = buildImportTemplateCsv(templates, {
      templateBrand: KABRITA_BRAND_NAME,
    });
    expect(csv.slice(1).split("\r\n")[0].split(",")).toEqual(
      kabritaImportHeaders,
    );

    const preview = await parseTabularPreview({
      bytes: Buffer.from([
        kabritaImportHeaders.join(","),
        [
          "2026-08-04 10:00:00",
          "小红书",
          "佳贝艾特店铺",
          "历史备注",
          "BUYER-1",
          "ORDER-1",
          "2026-08-03 12:00:00",
          "2",
          "1",
          "kabrita-user",
          "97【示例笔记】https://www.xiaohongshu.com/explore/kabrita-1",
          "荷兰佳贝1",
          "佳贝艾特2026年8月小红书种草审核",
        ].join(","),
      ].join("\r\n")),
      fileName: "佳贝艾特.csv",
      sourceType: "CSV",
      templates,
    });
    expect(preview.templateBrand).toBe("佳贝艾特");
    expect(preview.sourceLabel).toBe("佳贝艾特 Excel");
    expect(preview.recognizedFields.map((field) => field.header)).toEqual(
      kabritaImportHeaders,
    );
    expect(preview.missingRequiredFields).toEqual([]);
    expect(preview.validCount).toBe(1);
    expect(preview.previewRows[0].values).toMatchObject({
      xiaohongshuPublishLink:
        "97【示例笔记】https://www.xiaohongshu.com/explore/kabrita-1",
      purchaseProductLine: "荷兰佳贝1",
    });
    expect(preview.recognizedFields.map((field) => field.field)).not.toEqual(
      expect.arrayContaining(["productStage", "productName"]),
    );
  });

  it("把小红书发布链接、购买产品线和活动名称作为必填字段", async () => {
    const withoutLink = kabritaImportHeaders.filter(
      (header) => header !== "小红书发布链接",
    );
    const linkMissing = await parseTabularPreview({
      bytes: Buffer.from(
        `${withoutLink.join(",")}\r\n${withoutLink
          .map((header) => (header === "购买产品线" ? "荷兰佳贝1" : ""))
          .join(",")}`,
      ),
      fileName: "缺少链接.csv",
      sourceType: "CSV",
      templates,
    });
    expect(linkMissing.templateBrand).toBe("佳贝艾特");
    expect(linkMissing.missingRequiredFields).toEqual([
      "xiaohongshuPublishLink",
    ]);

    const blankProductLine = await parseTabularPreview({
      bytes: Buffer.from(
        `${kabritaImportHeaders.join(",")}\r\n${kabritaImportHeaders
          .map((header) =>
            header === "小红书发布链接"
              ? "https://www.xiaohongshu.com/explore/kabrita-blank"
              : "",
          )
          .join(",")}`,
      ),
      fileName: "产品线为空.csv",
      sourceType: "CSV",
      templates,
    });
    expect(blankProductLine.previewRows[0].errors).toContain(
      "缺少必填字段：购买产品线",
    );
    expect(blankProductLine.previewRows[0].errors.join("、")).not.toMatch(
      /阶段|产品系列|订单号/u,
    );
  });

  it("保存13列原值并用系统审核结论生成13列加自审的佳贝艾特导出", async () => {
    const rawValues = Object.fromEntries(
      KABRITA_IMPORT_FIELDS.map((field, index) => [
        field,
        field === "xiaohongshuPublishLink"
          ? "标题 https://www.xiaohongshu.com/explore/kabrita-export"
          : field === "purchaseProductLine"
            ? "港版佳贝3"
            : `原值-${index + 1}`,
      ]),
    );
    const notes = buildImportedTaskNotes({
      platform: "小红书",
      templateMetadata: {
        templateBrand: "佳贝艾特",
        rawValues,
      },
    });
    expect(importedTemplateMetadataFromNotes(notes)?.rawValues).toEqual(
      rawValues,
    );

    const row: Parameters<typeof auditResultToKabritaExportRecord>[0] = {
      autoStatus: "FAILED",
      pageStatus: "NORMAL",
      bodyStatus: "PRESENT",
      topicsCompliant: true,
      failureReasons: '["图片数量不足（2/3）"]',
      imageExtractionStatus: "SUCCESS",
      imageStatus: "NON_COMPLIANT",
      task: {
        url: "https://www.xiaohongshu.com/explore/kabrita-export",
        failureCode: null,
        failureMessage: null,
        pageTitle: "佳贝艾特笔记",
        pageType: "NOTE_DETAIL",
        notes,
        productStage: "GUM",
        product: {
          name: "佳贝艾特港版",
          seriesName: "佳贝艾特港版",
          brandName: "佳贝艾特",
        },
      },
      note: {
        url: "https://www.xiaohongshu.com/explore/kabrita-export",
        finalUrl: null,
        publishedAt: null,
        title: "佳贝艾特笔记",
        body: "正文",
      },
      manualReviews: [],
    };
    const record = auditResultToKabritaExportRecord(row);
    expect(Object.keys(record)).toEqual(KABRITA_EXPORT_FIELDS);
    expect(record.purchaseProductLine).toBe("港版佳贝3");
    expect(record.xiaohongshuPublishLink).toBe(
      "标题 https://www.xiaohongshu.com/explore/kabrita-export",
    );
    expect(record.selfReview).toBe(
      "N-图片不足；图片数量不足：当前 2 张，要求 ≥3 张",
    );

    expect(
      auditResultToKabritaExportRecord({
        ...row,
        autoStatus: "PASSED",
        imageStatus: "COMPLIANT",
        failureReasons: "[]",
      }).selfReview,
    ).toBe("Y");
    expect(
      auditResultToKabritaExportRecord({
        ...row,
        autoStatus: "FAILED",
        imageStatus: "COMPLIANT",
        failureReasons: '["基础奖励未达成：互动合计 9"]',
      }).selfReview,
    ).toBe("N-其他不合规；基础奖励未达成：互动合计 9");
    expect(
      auditResultToKabritaExportRecord({
        ...row,
        autoStatus: "NEEDS_REVIEW",
        imageStatus: "COMPLIANT",
        failureReasons: '["基础奖励互动数据无法确认，需人工复核"]',
      }).selfReview,
    ).toBe("");
    expect(
      auditResultToKabritaExportRecord({
        ...row,
        autoStatus: "FAILED",
        pageStatus: "NO_PERMISSION",
        failureReasons: '["当前账号无权访问笔记"]',
      }).selfReview,
    ).toBe("N-帖子无法查看；页面无法访问：当前账号无权访问笔记");

    const exportBytes = await buildConfiguredWorkbook({
      templates,
      kind: "auditResults",
      records: [record],
      templateBrand: "佳贝艾特",
    });
    const exportWorkbook = new ExcelJS.Workbook();
    await exportWorkbook.xlsx.load(exportBytes);
    const sheet = exportWorkbook.worksheets[0];
    const headers = (sheet.getRow(1).values as unknown[]).slice(1);
    expect(headers).toEqual(kabritaExportHeaders);
    expect(headers).not.toEqual(
      expect.arrayContaining(["是否符合", "阶段", "IFFO", "GUM", "产品阶段话题"]),
    );
    expect(sheet.getCell("N2").text).toBe(
      "N-图片不足；图片数量不足：当前 2 张，要求 ≥3 张",
    );
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet.autoFilter).toBeTruthy();
  });

  it("混合品牌导出使用互不污染的达能和佳贝艾特工作表", async () => {
    const bytes = await buildConfiguredWorkbook({
      templates,
      kind: "auditResults",
      records: [],
      sections: [
        {
          sheetName: "达能审核结果",
          records: [{
            commercePlatform: "京东",
            productName: "爱他美澳洲白金版",
            productStageTopic: "IFFO",
            selfReview: "Y",
          }],
        },
        {
          sheetName: "佳贝艾特审核结果",
          templateBrand: "佳贝艾特",
          records: [{
            purchaseProductLine: "荷兰佳贝1",
            xiaohongshuPublishLink: "https://xhslink.com/kabrita",
            selfReview: "Y",
          }],
        },
      ],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "达能审核结果",
      "佳贝艾特审核结果",
    ]);
    expect(
      (workbook.getWorksheet("达能审核结果")!.getRow(1).values as unknown[])
        .slice(1),
    ).toEqual([
      "平台",
      "店铺名称",
      "客户名",
      "产品系列",
      "阶段",
      "订单编号",
      "内容渠道",
      "链接",
      "发帖时间",
      "活动名称",
      "自审",
    ]);
    expect(
      (workbook.getWorksheet("佳贝艾特审核结果")!.getRow(1).values as unknown[])
        .slice(1),
    ).toEqual(kabritaExportHeaders);
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

  it("新十一列表格读取人工识别字段并继续识别小红书短链接", async () => {
    const csv = [
      "平台,店铺名称（必填）,客户名（必填）,产品系列（必填）,阶段（IFFO/GUM）,段位,订单编号,内容渠道,链接（必填）,发布时间（必填）,活动名称（必填）",
      "京东,京东健康官方进口超市,示例客户,爱他美奇迹绿罐,IFFO,2段,ORDER-1001,小红书,https://xhslink.com/new-template,2026-08-03 12:00:00,达能2026年8月小红书种草审核",
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
      commercePlatform: "京东",
      shopName: "京东健康官方进口超市",
      customerName: "示例客户",
      orderNumber: "ORDER-1001",
      contentChannel: "小红书",
      noteUrl: "https://xhslink.com/new-template",
      publishTime: "2026-08-03 12:00:00",
      activityName: "达能2026年8月小红书种草审核",
    });
    expect(
      importedTaskMetadataFromNotes(
        buildImportedTaskNotes(result.previewRows[0].values),
      ),
    ).toMatchObject({
      platform: "",
      shopName: "京东健康官方进口超市",
      customerName: "示例客户",
      orderNumber: "ORDER-1001",
      contentChannel: "小红书",
      publishTime: "2026-08-03 12:00:00",
      activityName: "达能2026年8月小红书种草审核",
    });

    const missingOrder = await parseTabularPreview({
      bytes: Buffer.from(csv.replace("ORDER-1001", "")),
      fileName: "订单为空.csv",
      sourceType: "CSV",
      templates,
    });
    expect(missingOrder.validCount).toBe(1);
    expect(missingOrder.invalidCount).toBe(0);
    expect(missingOrder.rows[0].errors).toEqual([]);
    expect(missingOrder.rows[0].values.orderNumber).toBe("");
  });

  it("订单编号、成交平台和渠道可推断，其余必填字段逐项拦截", async () => {
    const headers = [
      "平台（必填）",
      "店铺名称（必填）",
      "客户名（必填）",
      "产品系列（必填）",
      "阶段（IFFO/GUM）",
      "段位",
      "订单编号",
      "内容渠道（必填）",
      "链接（必填）",
      "发帖时间（必填）",
      "活动名称",
    ];
    const values = [
      "京东",
      "京东健康官方进口超市",
      "示例客户",
      "爱他美奇迹绿罐",
      "IFFO",
      "2段",
      "",
      "小红书",
      "https://xhslink.com/required-fields",
      "2026-08-03 12:00:00",
      "达能2026年8月小红书种草审核",
    ];
    const required = [
      [1, "店铺名称（必填）"],
      [2, "客户名（必填）"],
      [3, "产品系列（必填）"],
      [4, "阶段（IFFO/GUM）"],
      [8, "链接（必填）"],
      [9, "发布时间（必填）"],
      [10, "活动名称（必填）"],
    ] as const;

    for (const [index, displayName] of required) {
      const row = [...values];
      row[index] = "";
      const result = await parseTabularPreview({
        bytes: Buffer.from(`${headers.join(",")}\r\n${row.join(",")}`),
        fileName: `缺少-${index}.csv`,
        sourceType: "CSV",
        templates,
      });
      expect(result.validCount).toBe(0);
      expect(result.rows[0].errors).toContain(
        index === 10 ? "活动名称不能为空" : `缺少必填字段：${displayName}`,
      );
    }
  });

  it("清晰提示缺少必填字段、重复表头、空文件和乱码CSV", async () => {
    const outdated = await parseTabularPreview({
      bytes: Buffer.from(
        "平台,店铺名称（必填）,客户名（必填）,产品系列（必填）,阶段（IFFO/GUM）,段位,订单编号,内容渠道,链接（必填）,发布时间（必填）\r\n京东,示例店铺,示例客户,爱他美澳洲白金版,IFFO,2段,,小红书,https://xhslink.com/outdated,2026-08-03 12:00:00",
      ),
      fileName: "旧模板.csv",
      sourceType: "CSV",
      templates,
    });
    expect(outdated.rows[0].errors).toContain(
      "当前模板缺少“活动名称（必填）”列，请下载最新版导入模板后重新填写",
    );

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
  it("下载模板按线下表格顺序生成十一列、动态活动下拉并保留筛选", async () => {
    const bytes = await buildImportTemplateWorkbook(templates, {
      activityNames: ["达能2026年8月小红书种草审核", "佳贝艾特2026年8月小红书种草审核"],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "笔记导入",
      "活动列表",
      "填写说明",
    ]);
    expect(workbook.getWorksheet("笔记导入")?.getCell("A1").text).toBe(
      "平台",
    );
    expect(workbook.getWorksheet("填写说明")?.getCell("B2").text).toBe(
      templates.templateVersion,
    );
    const headerValues = (workbook.getWorksheet("笔记导入")?.getRow(1)
      .values || []) as unknown[];
    const headers = headerValues.slice(1).map(String);
    expect(headers).toEqual([
      "平台",
      "店铺名称（必填）",
      "客户名（必填）",
      "产品系列（必填）",
      "阶段（IFFO/GUM）",
      "段位",
      "订单编号",
      "内容渠道",
      "链接（必填）",
      "发布时间（必填）",
      "活动名称（必填）",
    ]);
    const stageCell = workbook.getWorksheet("笔记导入")?.getCell("E2");
    expect(stageCell?.text).toBe("IFFO");
    expect(stageCell?.dataValidation).toMatchObject({
      type: "list",
      formulae: ['"IFFO,GUM"'],
      error: "产品阶段话题请填写 IFFO 或 GUM。",
    });
    expect(workbook.getWorksheet("笔记导入")?.getCell("F2").dataValidation)
      .toMatchObject({
        type: "list",
        formulae: ['"P段,1段,2段,3段,4段,1+段,2+段"'],
      });
    expect(workbook.getWorksheet("笔记导入")?.getCell("H2").text).toBe(
      "小红书",
    );
    expect(workbook.getWorksheet("笔记导入")?.getCell("K2").dataValidation)
      .toMatchObject({ type: "list", formulae: ["VERIDIA_ACTIVITY_NAMES"] });
    expect(workbook.getWorksheet("笔记导入")?.getCell("K10000").dataValidation)
      .toMatchObject({ type: "list" });
    expect(workbook.getWorksheet("活动列表")?.state).toBe("veryHidden");
    expect(workbook.getWorksheet("活动列表")?.getCell("A2").text).toBe(
      "达能2026年8月小红书种草审核",
    );
    expect(workbook.getWorksheet("笔记导入")?.getColumn(10).numFmt).toBe(
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

  it("仓库内标准模板同步十一列、筛选及阶段与段位校验", async () => {
    const noteWorkbook = new ExcelJS.Workbook();
    await noteWorkbook.xlsx.load(
      (await readFile("templates/笔记导入模板.xlsx")) as unknown as ExcelJS.Buffer,
    );
    const noteSheet = noteWorkbook.worksheets[0];
    expect((noteSheet.getRow(1).values as unknown[]).slice(1)).toEqual([
      "平台",
      "店铺名称（必填）",
      "客户名（必填）",
      "产品系列（必填）",
      "阶段（IFFO/GUM）",
      "段位",
      "订单编号",
      "内容渠道",
      "链接（必填）",
      "发布时间（必填）",
      "活动名称（必填）",
    ]);
    expect(noteSheet.getCell("E2").text).toBe("IFFO");
    expect(noteSheet.getCell("E2").dataValidation).toMatchObject({
      type: "list",
      formulae: ['"IFFO,GUM"'],
    });
    expect(noteSheet.getCell("F2").text).toBe("2段");
    expect(noteSheet.getCell("F2").dataValidation).toMatchObject({
      type: "list",
      formulae: ['"P段,1段,2段,3段,4段,1+段,2+段"'],
    });
    expect(noteSheet.getCell("H2").text).toBe("小红书");
    expect(noteSheet.getCell("J2").numFmt).toBe("yyyy-mm-dd hh:mm:ss");
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
    const productNames = [
      "爱他美澳洲白金版",
      "爱他美德国白金版",
      "爱他美奇迹绿罐",
      "爱他美亲熠5HMO",
      "爱他美至熠",
      "未配置简称产品",
    ];
    const records = productNames.map((productName, index) => ({
      noteUrl: `https://xhslink.com/${index + 1}`,
      productName,
      activityName: "7月活动",
      auditResult: "审核通过",
    }));
    const csv = buildConfiguredCsv({
      templates,
      kind: "auditResults",
      records,
    });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split("\r\n")[0].split(",")[0]).toBe("平台");
    expect(csv).toContain("爱他美澳洲白金版");

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
    expect(
      workbook.worksheets[0].getColumn(4).values.slice(2),
    ).toEqual(["澳白", "德白", "绿罐", "白罐", "至熠", "未配置简称产品"]);
  });

  it("自审按单一优先级细分失败原因且订单编号不参与审核", () => {
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
        platform: "XIAOHONGSHU",
        channel: "XIAOHONGSHU",
        commercePlatform: "JD",
        notes: buildImportedTaskNotes({
          platform: "京东",
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
      commercePlatform: "京东",
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
    expect(imageProblem.selfReview).toBe("N-图片不足");

    const topicFailure = auditResultToExportRecord(
      {
        ...baseRow,
        autoStatus: "FAILED",
        topicsCompliant: false,
        failureReasons: '["缺少精准话题"]',
      },
      templates,
    );
    expect(topicFailure.selfReview).toBe("N-缺少话题");

    const compactSource: Parameters<
      typeof auditResultToCompactExportRecord
    >[0] = {
      autoStatus: baseRow.autoStatus,
      pageStatus: baseRow.pageStatus,
      bodyStatus: baseRow.bodyStatus,
      topicsCompliant: baseRow.topicsCompliant,
      failureReasons: baseRow.failureReasons,
      imageExtractionStatus: baseRow.imageExtractionStatus,
      imageStatus: baseRow.imageStatus,
      task: baseRow.task,
      note: baseRow.note,
      manualReviews: baseRow.manualReviews,
    };
    const compact = auditResultToCompactExportRecord(compactSource);
    expect(Object.keys(compact)).toEqual(RESULT_EXPORT_FIELDS);
    expect(compact).toMatchObject({
      originalUrl: "https://xhslink.com/original",
      orderNumber: "ORDER-1001",
      selfReview: "Y",
    });

    const selfReview = (
      input: Partial<typeof compactSource>,
    ) => auditResultToCompactExportRecord({
      ...compactSource,
      ...input,
      task: { ...compactSource.task, ...input.task },
      note: { ...compactSource.note, ...input.note },
    }).selfReview;
    expect(selfReview({
      autoStatus: "FAILED",
      manualReviews: [{ result: "PASSED" }],
    })).toBe("Y");
    expect(selfReview({
      autoStatus: "FAILED",
      topicsCompliant: false,
      failureReasons: '["缺少指定话题"]',
      task: {
        ...compactSource.task,
        notes: buildImportedTaskNotes({ contentChannel: "抖音" }),
      },
    })).toBe("N-内容渠道不支持");
    expect(selfReview({
      autoStatus: "FAILED",
      topicsCompliant: false,
      failureReasons: '["话题未命中"]',
    })).toBe("N-缺少话题");
    expect(selfReview({
      autoStatus: "FAILED",
      bodyStatus: "EMPTY",
      failureReasons: '["有效正文字数不足（29/30）"]',
    })).toBe("N-字数不够；正文字数不足：当前 29 字，要求 ≥30 字");
    expect(selfReview({
      autoStatus: "FAILED",
      imageStatus: "NON_COMPLIANT",
      failureReasons: '["图片数量不足（1/2）"]',
    })).toBe("N-图片不足；图片数量不足：当前 1 张，要求 ≥2 张");
    expect(selfReview({
      autoStatus: "FAILED",
      failureReasons: '["正文段位不属于当前产品阶段话题：IFFO"]',
    })).toBe("N-阶段不符；正文段位不属于当前产品阶段话题：IFFO");
    expect(selfReview({
      autoStatus: "FAILED",
      failureReasons: '["笔记当前未公开"]',
    })).toBe("N-其他不合规；笔记当前未公开");
    expect(selfReview({
      autoStatus: "NEEDS_REVIEW",
      imageExtractionStatus: "IMAGES_READ_FAILED",
      failureReasons: '["图片读取失败，待人工复核"]',
    })).toBe("");
    expect(selfReview({
      autoStatus: "FAILED",
      pageStatus: "NOT_FOUND",
      topicsCompliant: false,
      bodyStatus: "EMPTY",
      imageStatus: "NON_COMPLIANT",
      failureReasons:
        '["页面不存在","缺少话题","字数不足","图片不足","阶段不符"]',
      task: {
        ...compactSource.task,
        notes: buildImportedTaskNotes({ contentChannel: "抖音" }),
      },
    })).toBe("N-帖子无法查看；页面无法访问：页面不存在");
    expect(selfReview({
      autoStatus: "FAILED",
      topicsCompliant: false,
      bodyStatus: "EMPTY",
      imageStatus: "NON_COMPLIANT",
      failureReasons: '["缺少话题","字数不足","图片不足","阶段不符"]',
    })).toBe("N-缺少话题");
    expect(selfReview({
      autoStatus: "FAILED",
      bodyStatus: "EMPTY",
      imageStatus: "NON_COMPLIANT",
      failureReasons: '["字数不足","图片不足","阶段不符"]',
    })).toBe("N-字数不够");
    expect(selfReview({
      autoStatus: "FAILED",
      imageStatus: "NON_COMPLIANT",
      failureReasons: '["图片不足","阶段不符"]',
    })).toBe("N-图片不足");
    const allowedSelfReviewValues = [
      "Y",
      "N-帖子无法查看",
      "N-内容渠道不支持",
      "N-缺少话题",
      "N-字数不够",
      "N-图片不足",
      "N-阶段不符",
      "N-其他不合规",
      "",
    ];
    for (const value of [
      passed.selfReview,
      unavailable.selfReview,
      imageProblem.selfReview,
      topicFailure.selfReview,
      selfReview({ autoStatus: "FAILED", failureReasons: "[]" }),
      selfReview({ autoStatus: "NEEDS_REVIEW" }),
    ]) {
      expect(allowedSelfReviewValues).toContain(value);
      expect(value).not.toBe("N-产品不符");
      expect(value).not.toBe("N-图片看不到奶粉段数");
    }

    const compactWithoutOrder = auditResultToCompactExportRecord({
      ...compactSource,
      task: {
        ...compactSource.task,
        notes: buildImportedTaskNotes({
          platform: "小红书",
          shopName: "示例店铺",
          customerName: "示例客户",
          orderNumber: "",
          contentChannel: "小红书",
          publishTime: "2026-08-03 12:00:00",
        }),
      },
    });
    expect(compactWithoutOrder.orderNumber).toBe("");

    const legacyChannelOnly = auditResultToCompactExportRecord({
      ...compactSource,
      task: {
        ...compactSource.task,
        channel: null,
        commercePlatform: null,
        platform: "XIAOHONGSHU",
        notes: buildImportedTaskNotes({
          platform: "小红书",
          contentChannel: "小红书",
        }),
      },
    });
    expect(legacyChannelOnly.commercePlatform).toBe("—");
    expect(legacyChannelOnly.contentChannel).toBe("小红书");
  });

  it("18条当前筛选结果生成包含活动名称的线下处理字段", async () => {
    const records = Array.from({ length: 18 }, (_, index) => ({
      platform: "小红书",
      shopName: "示例店铺",
      customerName: "示例客户",
      productName: "爱他美澳洲白金版",
      productStageTopic: "IFFO",
      orderNumber: index === 0 ? "" : `ORDER-${index + 1}`,
      contentChannel: "小红书",
      originalUrl: `https://www.xiaohongshu.com/explore/export-${index + 1}`,
      publishTime: new Date(Date.UTC(2026, 7, 3, 12, 0, 0)),
      activityName: "达能2026年8月小红书种草审核",
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
      "活动名称",
      "自审",
    ]);
    expect(sheet.getColumn(9).numFmt).toBe("yyyy-mm-dd hh:mm:ss");
    expect(sheet.getColumn(8).alignment?.wrapText).toBe(true);
    expect(sheet.getColumn(headers.indexOf("产品系列")).values).toContain(
      "澳白",
    );
    expect(sheet.getCell("F2").text).toBe("");
    expect(sheet.getCell("F3").text).toBe("ORDER-2");
    expect(sheet.getCell("K2").dataValidation).toMatchObject({
      type: "list",
      allowBlank: true,
      formulae: [
        '"Y,N-帖子无法查看,N-内容渠道不支持,N-缺少话题,N-字数不够,N-图片不足,N-阶段不符,N-其他不合规"',
      ],
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
