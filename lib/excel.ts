import ExcelJS from "exceljs";
import type { AuditResult, Campaign, NoteRecord, Product } from "@prisma/client";
import {
  allowedBodyStageLabels,
  detectBodyProductStages,
  productStageTopicLabel,
  stageTopicFromRuleSnapshot,
} from "@/lib/product-stage";
import { normalizeTopic } from "@/lib/topic";
import {
  businessSourceLabel,
  businessFailureReasonLabel,
  businessStatusLabel,
} from "@/lib/zh-CN";

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
    { header: "原始笔记链接", key: "url", width: 45 },
    { header: "最终跳转链接", key: "finalUrl", width: 45 },
    { header: "笔记ID", key: "noteId", width: 20 },
    { header: "产品名称", key: "productName", width: 24 },
    { header: "活动名称", key: "campaignName", width: 30 },
    { header: "任务来源", key: "source", width: 16 },
    { header: "产品阶段话题", key: "productStageTopic", width: 34 },
    { header: "正文允许段位", key: "allowedBodyStages", width: 28 },
    { header: "正文实际识别段位", key: "detectedBodyStages", width: 24 },
    { header: "正文段位结果", key: "bodyStageResult", width: 18 },
    { header: "要求阶段话题", key: "requiredStageTopic", width: 24 },
    { header: "阶段话题命中", key: "stageTopicMatched", width: 18 },
    { header: "阶段话题可点击", key: "stageTopicClickable", width: 20 },
    { header: "规则版本", key: "ruleVersion", width: 12 },
    { header: "页面状态", key: "pageStatus", width: 16 },
    { header: "文章状态", key: "bodyStatus", width: 14 },
    { header: "笔记类型", key: "noteType", width: 14 },
    { header: "图片提取状态", key: "imageExtractionStatus", width: 20 },
    { header: "图片数量", key: "imageCount", width: 12 },
    { header: "图片数量合规", key: "imageStatus", width: 20 },
    { header: "标签内容", key: "topics", width: 40 },
    { header: "标签合规", key: "topicsCompliant", width: 12 },
    { header: "蓝色标签状态", key: "clickable", width: 16 },
    { header: "缺失标签", key: "missing", width: 30 },
    { header: "禁止标签", key: "forbidden", width: 30 },
    { header: "笔记正文", key: "body", width: 60 },
    { header: "审核结果", key: "status", width: 16 },
    { header: "不通过原因", key: "reasons", width: 50 },
    { header: "审核时间", key: "auditedAt", width: 22 },
    { header: "人工审核结果", key: "manualResult", width: 16 },
    { header: "人工审核意见", key: "manualComment", width: 40 },
  ];
  for (const row of rows) {
    const manual = row.manualReviews[0];
    const missingTopics = (JSON.parse(row.missingTopics) as string[]).join(
      "、",
    );
    const forbiddenTopics = (
      JSON.parse(row.forbiddenTopics) as string[]
    ).join("、");
    const failureReasons = (JSON.parse(row.failureReasons) as string[])
      .filter(
        (reason) =>
          !/首图|视觉|产品实拍|合照|罐体|平台导向|图片内容/u.test(reason),
      )
      .map(businessFailureReasonLabel)
      .join("；");
    const bodyStage = detectBodyProductStages(
      row.note.body,
      row.task.productStage,
    );
    const stageTopic = stageTopicFromRuleSnapshot(row.ruleSnapshot);
    const stageTopicMatch = stageTopic
      ? row.note.topics.find(
          (topic) =>
            normalizeTopic(topic.displayText) === normalizeTopic(stageTopic),
        )
      : undefined;
    const stageTopicClickable = Boolean(
      stageTopicMatch &&
        (stageTopicMatch.isClickable ||
          (stageTopicMatch.isLinkElement &&
            stageTopicMatch.hasHref &&
            stageTopicMatch.href &&
            stageTopicMatch.styleFeature)),
    );
    sheet.addRow({
      url: row.note.url,
      finalUrl: row.note.finalUrl || row.note.url,
      noteId: row.note.platformNoteId,
      productName: row.task.product.name,
      campaignName: row.task.campaign.name,
      source: businessSourceLabel(row.task.source),
      productStageTopic: productStageTopicLabel(row.task.productStage),
      allowedBodyStages: allowedBodyStageLabels(
        row.task.productStage,
      ).join("、"),
      detectedBodyStages: bodyStage?.detectedStages.join("、") || "段位未识别",
      bodyStageResult: bodyStage
        ? bodyStage.passed
          ? "合规"
          : "不合规"
        : "未配置",
      requiredStageTopic: stageTopic || null,
      stageTopicMatched: stageTopicMatch ? "是" : "否",
      stageTopicClickable: stageTopicClickable ? "是" : "否",
      ruleVersion: row.ruleVersion,
      pageStatus: businessStatusLabel(row.pageStatus),
      bodyStatus: businessStatusLabel(row.bodyStatus),
      noteType:
        row.noteType === "VIDEO_NOTE"
          ? "视频笔记"
          : row.noteType === "IMAGE_TEXT"
            ? "图文笔记"
            : "未知",
      imageExtractionStatus:
        row.imageExtractionStatus === "SUCCESS"
          ? "提取成功"
          : row.imageExtractionStatus === "VIDEO_NOTE"
            ? "视频笔记"
            : row.imageExtractionStatus === "IMAGES_READ_FAILED"
              ? "图片数量读取失败"
              : "未提取",
      imageCount:
        row.imageStatus === "COMPLIANT" || row.imageStatus === "NON_COMPLIANT"
          ? row.imageCount
          : null,
      imageStatus:
        row.imageStatus === "COMPLIANT"
          ? "合规"
          : row.imageStatus === "NON_COMPLIANT"
            ? "不合规"
            : row.imageStatus === "VIDEO_NOTE"
              ? "视频笔记，不适用"
              : row.imageStatus === "IMAGES_READ_FAILED"
                ? "读取失败，待人工复核"
                : "不适用",
      topics:
        row.note.topics.map((topic) => topic.displayText).join("、") || null,
      topicsCompliant: row.topicsCompliant ? "是" : "否",
      clickable: row.clickableCompliant ? "正常" : "异常",
      missing: missingTopics || null,
      forbidden: forbiddenTopics || null,
      body: row.note.body,
      status: businessStatusLabel(row.autoStatus, "audit"),
      reasons: failureReasons || null,
      auditedAt: row.auditedAt,
      manualResult: manual
        ? businessStatusLabel(manual.result, "audit")
        : "未人工复核",
      manualComment: manual?.comment || null,
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
