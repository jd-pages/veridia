import type { CompactAuditResultExportSourceRow } from "@/lib/import-export-templates/export";
import { businessFailureReasonLabel } from "@/lib/zh-CN";
import { isUnavailableNoteResult } from "@/lib/result-display";
import { importedTaskMetadataFromNotes } from "@/lib/import-task-metadata";
import { auditConclusionFailureReasons } from "@/lib/result-detail-presentation";

export type SelfReviewSource = Pick<CompactAuditResultExportSourceRow,
  "autoStatus" | "pageStatus" | "bodyStatus" | "topicsCompliant" | "failureReasons" |
  "ruleSnapshot" | "imageStatus" | "imageExtractionStatus" | "manualReviews" | "presentation"
> & {
  note: Pick<CompactAuditResultExportSourceRow["note"], "title" | "body" | "topics">;
  task: Pick<CompactAuditResultExportSourceRow["task"],
    "notes" | "failureCode" | "failureMessage" | "pageTitle" | "pageType">;
};

function list(value: string, separator: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.map(String).map(businessFailureReasonLabel).join(separator)
      : String(value || "");
  } catch {
    return String(value || "");
  }
}

export function compactSelfReview(row: SelfReviewSource) {
  if (
    row.presentation?.consistency.status ===
    "RESULT_CONSISTENCY_VIOLATION"
  ) {
    return "N-结果一致性异常";
  }
  const manual = row.manualReviews[0];
  if (manual?.result === "PASSED") return "Y";
  if (manual?.result === "FAILED") {
    const reason = manual.comment?.trim();
    return reason ? `N-人工不通过；${reason}` : "N-人工不通过";
  }
  const finalStatus = row.presentation?.conclusion.status || row.autoStatus;
  if (finalStatus === "PASSED") return "Y";

  const unavailable = isUnavailableNoteResult({
    pageStatus: row.pageStatus,
    failureReasons: row.failureReasons,
    pageTitle: row.task.pageTitle,
    note: { title: row.note.title, body: row.note.body },
    task: {
      failureCode: row.task.failureCode,
      failureMessage: row.task.failureMessage,
      pageTitle: row.task.pageTitle,
      pageType: row.task.pageType,
    },
  });
  const importedMetadata = importedTaskMetadataFromNotes(row.task.notes);
  const failureReasonList = row.presentation?.failureReasons.join(" ") ||
    list(row.failureReasons, " ");
  const evidence = [
    row.pageStatus,
    row.bodyStatus,
    row.imageExtractionStatus,
    row.imageStatus,
    row.task.failureCode,
    row.task.failureMessage,
    row.failureReasons,
    failureReasonList,
    importedMetadata.contentChannel,
  ]
    .filter(Boolean)
    .join(" ");

  if (
    unavailable ||
    row.pageStatus === "NO_PERMISSION" ||
    /PAGE_NOT_FOUND|PAGE_UNAVAILABLE|NOT_ACCESSIBLE|HTTP[_ -]?404|\b404\b|页面(?:无法访问|不见了|不存在)|笔记不存在|无法浏览|链接失效|该内容无法查看/iu.test(
      evidence,
    )
  ) {
    return "N-帖子无法查看";
  }
  if (
    /CONTENT_CHANNEL_UNSUPPORTED|UNSUPPORTED_CONTENT_CHANNEL|内容渠道.{0,8}(?:不支持|暂不支持)|(?:不支持|暂不支持).{0,8}内容渠道|快手/iu.test(
      evidence,
    )
  ) {
    return "N-内容渠道不支持";
  }
  if (finalStatus !== "FAILED") return "待人工复核";
  if (
    row.topicsCompliant === false ||
    /TOPIC(?:S)?_(?:MISSING|NOT_MATCHED|NON_COMPLIANT)|缺少.{0,8}话题|话题.{0,8}(?:未命中|不合规|缺失)|阶段话题.{0,8}缺失|未识别到话题|缺少精确话题/iu.test(
      evidence,
    )
  ) {
    return "N-缺少话题";
  }
  if (
    row.bodyStatus === "EMPTY" ||
    /BODY_(?:EMPTY|MISSING|TOO_SHORT)|正文.{0,8}(?:不存在|为空|过短)|有效正文字数不足|字数.{0,8}(?:不足|不达标|不够)/iu.test(
      evidence,
    )
  ) {
    return "N-字数不够";
  }
  if (
    row.imageStatus === "NON_COMPLIANT" ||
    /IMAGE_COUNT_(?:INSUFFICIENT|INVALID)|图片(?:数量)?.{0,8}(?:不足|不达标|不合规)|图片不足/iu.test(
      evidence,
    )
  ) {
    return "N-图片不足";
  }
  if (
    /BODY_STAGE_(?:MISMATCH|INVALID)|阶段.{0,8}(?:不匹配|不符)|段位.{0,8}(?:不属于|不匹配|不符)|IFFO.{0,12}GUM.{0,8}(?:不符|不匹配)|正文段位不属于|正文未出现对应段位/iu.test(
      evidence,
    )
  ) {
    return "N-阶段不符";
  }
  return "N-其他不合规";
}

export function detailedSelfReview(row: SelfReviewSource) {
  const summary = compactSelfReview(row);
  if (!summary || summary === "Y") return summary;
  let details = (row.presentation?.failureReasons ||
    auditConclusionFailureReasons(row)).filter(
    (reason) =>
      !/^(?:话题缺少|缺少话题|缺少指定话题|话题未命中|字数不足|图片不足|阶段不符|不合规|审核失败)$/u.test(
        reason,
      ),
  );
  if (summary === "N-帖子无法查看") {
    details = details.map((reason) =>
      reason.startsWith("页面无法访问：")
        ? reason
        : `页面无法访问：${reason}`,
    );
  }
  return details.length ? `${summary}；${details.join("；")}` : summary;
}
