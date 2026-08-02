import ExcelJS from "exceljs";
import type { AuditResult, Campaign, NoteRecord, Product } from "@prisma/client";
import {
  productStageTopicLabel,
  stageTopicFromRuleSnapshot,
} from "@/lib/product-stage";
import { businessFailureReasonLabel, businessStatusLabel } from "@/lib/zh-CN";
import { parseStoredStringArray } from "@/lib/stored-json";

export function excelResponse(
  buffer: ExcelJS.Buffer,
  fileName: string,
): Response {
  return new Response(new Uint8Array(buffer as ArrayBuffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "no-store",
    },
  });
}

export function cellText(cell: ExcelJS.Cell): string {
  if (cell.value == null) return "";
  if (
    typeof cell.value === "object" &&
    "richText" in cell.value &&
    Array.isArray(cell.value.richText)
  ) {
    return cell.value.richText
      .map((part) => String(part.text || ""))
      .join("")
      .trim();
  }
  if (cell.text) return cell.text.trim();
  if (typeof cell.value === "object" && "text" in cell.value) {
    return String(cell.value.text).trim();
  }
  return String(cell.value).trim();
}

export type ResultExportRow = AuditResult & {
  note: NoteRecord & {
    topics: Array<{
      displayText: string;
      isClickable: boolean;
      isLinkElement: boolean;
      hasHref: boolean;
      href: string | null;
      styleFeature: boolean;
    }>;
  };
  task: {
    productStage: string | null;
    source: string;
    product: Product;
    campaign: Campaign;
  };
  manualReviews: Array<{ result: string; comment: string | null }>;
};

export async function buildResultsWorkbook(rows: ResultExportRow[]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("审核结果");
  sheet.columns = [
    { header: "产品", key: "productName", width: 24 },
    { header: "活动", key: "campaignName", width: 30 },
    { header: "产品阶段话题", key: "productStageTopic", width: 34 },
    { header: "要求阶段话题", key: "requiredStageTopic", width: 24 },
    { header: "最终审核结论", key: "status", width: 18 },
    { header: "人工复核状态", key: "manualStatus", width: 18 },
    { header: "失败原因", key: "reasons", width: 50 },
    { header: "正文有效字数", key: "effectiveBodyLength", width: 16 },
    { header: "图片数量", key: "imageCount", width: 12 },
    { header: "话题审核结果", key: "topicsStatus", width: 18 },
    { header: "当前公开状态", key: "publicStatus", width: 18 },
    { header: "正文内容", key: "body", width: 60 },
  ];
  for (const row of rows) {
    const manual = row.manualReviews[0];
    const failureReasons = parseStoredStringArray(row.failureReasons)
      .filter(
        (reason) =>
          !/首图|视觉|产品实拍|合照|罐体|平台导向|图片内容/u.test(reason),
      )
      .map(businessFailureReasonLabel)
      .join("；");
    const finalStatus = manual?.result || row.autoStatus;
    sheet.addRow({
      productName: row.task.product.name,
      campaignName: row.task.campaign.name,
      productStageTopic: productStageTopicLabel(row.task.productStage),
      requiredStageTopic:
        stageTopicFromRuleSnapshot(row.ruleSnapshot) || null,
      status: businessStatusLabel(finalStatus, "audit"),
      manualStatus: manual
        ? manual.result === "PASSED"
          ? "已人工通过"
          : "已人工不通过"
        : row.autoStatus === "NEEDS_REVIEW"
          ? "待人工复核"
          : "无需复核",
      reasons: failureReasons || null,
      effectiveBodyLength: row.effectiveBodyLength,
      imageCount: row.imageCount,
      topicsStatus: row.topicsCompliant ? "合规" : "不合规",
      publicStatus: businessStatusLabel(row.publicStatus),
      body: row.note.body,
    });
  }
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFB4232A" },
  };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(sheet.rowCount, 1), column: sheet.columnCount },
  };
  return workbook.xlsx.writeBuffer();
}
