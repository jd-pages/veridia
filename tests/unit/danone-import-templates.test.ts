import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { BUILTIN_IMPORT_EXPORT_TEMPLATES } from "@/lib/import-export-templates/config";
import {
  buildConfiguredWorkbook,
  buildImportTemplateWorkbook,
} from "@/lib/import-export-templates/export";
import { parseTabularPreview } from "@/lib/import-export-templates/tabular";
import {
  DANONE_AGENCY_IMPORT_FIELDS,
  DANONE_CUSTOMER_IMPORT_FIELDS,
  DANONE_MIXED_SUMMARY_FIELDS,
  inferDanoneAgencyProductStage,
} from "@/lib/import-template-type";

const customerHeaders = [
  "平台（必填）",
  "店铺名称（必填）",
  "客户名（必填）",
  "产品系列（必填）",
  "阶段（必填）",
  "段位（必填）",
  "订单编号（必填）",
  "内容渠道（必填）",
  "链接（必填）",
  "发布时间（必填）",
  "活动名称（必填）",
];

const agencyHeaders = customerHeaders.filter((header) => header !== "阶段（必填）");

const templateBytes = new Map<string, Promise<ExcelJS.Buffer>>();

async function customerDownloadWorkbook() {
  const type = "DANONE_CUSTOMER";
  if (!templateBytes.has(type)) {
    templateBytes.set(
      type,
      buildImportTemplateWorkbook(BUILTIN_IMPORT_EXPORT_TEMPLATES, {
        templateType: type,
        activityNames: ["达能2026年8月小红书种草审核"],
      }),
    );
  }
  const bytes = await templateBytes.get(type)!;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return { bytes, workbook };
}

describe("达能客户与代发 Excel 模板", () => {
  it("下载生成器只生成达能客户表头、模板元数据并把活动名称放在最后", async () => {
    const customer = await customerDownloadWorkbook();

    expect((customer.workbook.worksheets[0].getRow(1).values as unknown[]).slice(1)).toEqual(
      customerHeaders,
    );
    expect(agencyHeaders).not.toContain("阶段（必填）");
    expect(customer.workbook.getWorksheet("VERIDIA模板信息")?.getCell("B1").text).toBe(
      "DANONE_CUSTOMER",
    );
    expect(DANONE_CUSTOMER_IMPORT_FIELDS.at(-1)).toBe("activityName");
    expect(DANONE_AGENCY_IMPORT_FIELDS.at(-1)).toBe("activityName");
  });

  it("按元数据识别模板且严格校验客户阶段与代发段位", async () => {
    const compactWorkbook = async (
      type: "DANONE_CUSTOMER" | "DANONE_AGENCY",
      headers: string[],
      values: string[],
    ) => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("导入");
      sheet.addRow(headers);
      sheet.addRow(values);
      const metadata = workbook.addWorksheet("VERIDIA模板信息", {
        state: "veryHidden",
      });
      metadata.getCell("B1").value = type;
      return workbook.xlsx.writeBuffer();
    };
    const customerBytes = await compactWorkbook(
      "DANONE_CUSTOMER",
      customerHeaders,
      ["京东", "店铺", "客户", "澳白", "2段", "IFFO", "订单", "小红书", "https://xhslink.com/a", "2026-08-01", "达能2026年8月小红书种草审核"],
    );
    const agencyBytes = await compactWorkbook(
      "DANONE_AGENCY",
      agencyHeaders,
      ["京东", "店铺", "客户", "澳白2", "IFFO", "订单", "小红书", "https://xhslink.com/b", "2026-07-01", "达能2026年7月小红书种草审核"],
    );
    const customerPreview = await parseTabularPreview({
      bytes: new Uint8Array(customerBytes as ArrayBuffer),
      fileName: "customer.xlsx",
      sourceType: "EXCEL_XLSX",
      templates: BUILTIN_IMPORT_EXPORT_TEMPLATES,
    });
    const agencyPreview = await parseTabularPreview({
      bytes: new Uint8Array(agencyBytes as ArrayBuffer),
      fileName: "agency.xlsx",
      sourceType: "EXCEL_XLSX",
      templates: BUILTIN_IMPORT_EXPORT_TEMPLATES,
    });
    expect(customerPreview.templateType).toBe("DANONE_CUSTOMER");
    expect(customerPreview.rows[0].values).toMatchObject({
      productStageDetail: "2段",
      productStage: "IFFO",
    });
    expect(agencyPreview.templateType).toBe("DANONE_AGENCY");
    expect(agencyPreview.rows[0].values.productStage).toBe("IFFO");
    expect(agencyPreview.rows[0].values.productStageDetail).toBeUndefined();

    const invalidAgencyBytes = await compactWorkbook(
      "DANONE_AGENCY",
      agencyHeaders,
      ["京东", "店铺", "客户", "澳白2", "", "订单", "小红书", "https://xhslink.com/c", "2026-07-01", "达能2026年7月小红书种草审核"],
    );
    const invalidAgency = await parseTabularPreview({
      bytes: new Uint8Array(invalidAgencyBytes as ArrayBuffer),
      fileName: "agency-empty-stage.xlsx",
      sourceType: "EXCEL_XLSX",
      templates: BUILTIN_IMPORT_EXPORT_TEMPLATES,
    });
    expect(invalidAgency.rows[0].errors).toContain("段位不能为空");
  });

  it.each([
    ["澳白2", "澳白", "2段", "IFFO"],
    ["澳白2段", "澳白", "2段", "IFFO"],
    ["德白P", "德白", "P段", "IFFO"],
    ["德白PRE", "德白", "P段", "IFFO"],
    ["德白1+", "德白", "1+段", "GUM"],
    ["德白2+", "德白", "2+段", "GUM"],
    ["型号2澳白", "型号2澳白", null, null],
  ])("只识别产品名称末尾段数：%s", (input, name, stage, group) => {
    expect(inferDanoneAgencyProductStage(input)).toMatchObject({
      originalProductName: input,
      normalizedProductName: name,
      inferredStage: stage,
      inferredGroup: group,
    });
  });

  it("混合导出生成汇总、代发和客户三个独立工作表", async () => {
    const agencyRecord = {
      templateType: "达能代发",
      activityMonth: "2026-07",
      activityName: "达能2026年7月小红书种草审核",
      productStage: "IFFO",
      productStageDetail: "",
      selfReview: "Y",
    };
    const customerRecord = {
      templateType: "达能客户",
      activityMonth: "2026-08",
      activityName: "达能2026年8月小红书种草审核",
      productStage: "GUM",
      productStageDetail: "3段",
      selfReview: "Y",
    };
    const bytes = await buildConfiguredWorkbook({
      templates: BUILTIN_IMPORT_EXPORT_TEMPLATES,
      kind: "auditResults",
      records: [agencyRecord, customerRecord],
      sections: [
        {
          sheetName: "审核结果汇总",
          records: [agencyRecord, customerRecord],
          templateType: "DANONE_CUSTOMER",
          fields: DANONE_MIXED_SUMMARY_FIELDS,
        },
        { sheetName: "达能代发", records: [agencyRecord], templateType: "DANONE_AGENCY" },
        { sheetName: "达能客户", records: [customerRecord], templateType: "DANONE_CUSTOMER" },
      ],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "审核结果汇总",
      "达能代发",
      "达能客户",
    ]);
    expect(workbook.getWorksheet("达能代发")?.getRow(1).values).not.toContain("阶段");
    expect(workbook.getWorksheet("达能客户")?.getRow(1).values).toEqual(
      expect.arrayContaining(["阶段", "段位"]),
    );
    const summary = workbook.getWorksheet("审核结果汇总")!;
    const stageColumn = (summary.getRow(1).values as unknown[]).indexOf("阶段");
    expect(summary.getRow(2).getCell(stageColumn).text).toBe("");
    expect(summary.getRow(3).getCell(stageColumn).text).toBe("3段");
  });

  it("纯代发导出不含阶段列，纯客户导出同时保留阶段和段位", async () => {
    const record = {
      productStage: "IFFO",
      productStageDetail: "2段",
      activityName: "达能2026年8月小红书种草审核",
      selfReview: "Y",
    };
    const agencyBytes = await buildConfiguredWorkbook({
      templates: BUILTIN_IMPORT_EXPORT_TEMPLATES,
      kind: "auditResults",
      records: [{ ...record, productStageDetail: "" }],
      templateType: "DANONE_AGENCY",
    });
    const customerBytes = await buildConfiguredWorkbook({
      templates: BUILTIN_IMPORT_EXPORT_TEMPLATES,
      kind: "auditResults",
      records: [record],
      templateType: "DANONE_CUSTOMER",
    });
    const agency = new ExcelJS.Workbook();
    const customer = new ExcelJS.Workbook();
    await agency.xlsx.load(agencyBytes);
    await customer.xlsx.load(customerBytes);
    const agencyHeaders = agency.worksheets[0].getRow(1).values as unknown[];
    const customerHeaders = customer.worksheets[0].getRow(1).values as unknown[];
    expect(agencyHeaders).not.toContain("阶段");
    expect(agencyHeaders).toContain("段位");
    expect(customerHeaders).toEqual(expect.arrayContaining(["阶段", "段位"]));
  });
});
