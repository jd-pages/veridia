"use client";

import { Tag, Tooltip, Typography } from "antd";
import { productStageTopicLabel } from "@/lib/product-stage";
import {
  auditConclusionCardLabel,
  auditConclusionCardTone,
  auditConclusionFailureReasons,
  minimumImageCountFromRuleSnapshot,
} from "@/lib/result-detail-presentation";
import { isUnavailableNoteResult } from "@/lib/result-display";
import { resultDetailLinks } from "@/lib/result-links";
import { parseStoredStringArray } from "@/lib/stored-json";
import { formatPlatformPublishedAt } from "@/lib/platform-published-at";
import { duplicateReauditMetadataFromNotes } from "@/lib/import-task-metadata";
import {
  commercePlatformLabel,
  contentChannelLabel,
  formatAuditTime,
  resolveTaskChannel,
} from "@/lib/result-source";
import { getTopicAuditSummary } from "./TopicAuditCell";
import ResultDetailLink from "./ResultDetailLink";
import type { ResultDetail, ResultRow } from "./types";
import styles from "./results-workbench.module.css";

function ReviewResult({ value }: { value: string }) {
  return (
    <span className={styles.reviewResult}>
      {value === "PASSED"
        ? "人工通过"
        : value === "FAILED"
          ? "人工不通过"
          : "待人工复核"}
    </span>
  );
}

interface BasicRewardEvidence {
  likeCount?: number | null;
  favoriteCount?: number | null;
  commentCount?: number | null;
  totalCount?: number | null;
  minimumTotal?: number;
  interactionReadable?: boolean;
  contentStatus?: string;
  rewardPassed?: boolean | null;
  finalStatus?: string;
}

function parseBasicRewardEvidence(value?: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as BasicRewardEvidence;
  } catch {
    return null;
  }
}

function auditStatusText(value?: string) {
  if (value === "PASSED") return "通过";
  if (value === "FAILED" || value === "READ_FAILED") return "不通过";
  return "待人工复核";
}

function publicStatusText(value?: string) {
  if (value === "PUBLIC") return "当前公开";
  if (value === "NOT_PUBLIC") return "当前不公开";
  if (value === "NOT_REQUIRED") return "无需审核";
  return "待确认";
}

export default function AuditDecisionSummary({
  row,
  detail,
}: {
  row: ResultRow;
  detail?: ResultDetail | null;
}) {
  const unavailable = isUnavailableNoteResult(row);
  const conclusion = auditConclusionCardLabel(row);
  const conclusionTone = auditConclusionCardTone(row);
  const failureReasons = auditConclusionFailureReasons(row);
  const topicSummary = getTopicAuditSummary(row);
  const expectedTopicCount =
    topicSummary.required.length +
    (topicSummary.stageCandidates.length ? 1 : 0);
  const matchedTopicCount =
    topicSummary.matched.length +
    (topicSummary.matchedStageCandidates.length ? 1 : 0);
  const topicNeedsReview =
    topicSummary.uncertain.length > 0 || topicSummary.stageGroupUncertain;
  const topicCompliant =
    row.topicsCompliant &&
    row.clickableCompliant &&
    !topicSummary.missing.length &&
    !topicSummary.forbidden.length &&
    !topicSummary.stageGroupMissing &&
    !topicSummary.stageGroupUnclickable &&
    !topicNeedsReview;
  const links = resultDetailLinks(row);
  const minimumImageCount = minimumImageCountFromRuleSnapshot(
    row.ruleSnapshot,
  );
  const reviews = detail?.manualReviews || row.manualReviews;
  const duplicateReaudit = duplicateReauditMetadataFromNotes(row.task.notes);
  const basicRewardRule = detail?.ruleResults.find(
    (item) => item.ruleKey === "KABRITA_BASIC_REWARD",
  );
  const basicReward = parseBasicRewardEvidence(basicRewardRule?.evidence);
  const channel = resolveTaskChannel(row.task);
  const channelLabel = contentChannelLabel(channel);
  const platformLabel = commercePlatformLabel(row.task.commercePlatform);
  const storeName = row.task.storeName?.trim() || "—";
  const orderNumber = row.task.orderNumber?.trim() || "—";
  const expectedStoreTopics = parseStoredStringArray(
    row.expectedStoreTopics,
  );
  if (!expectedStoreTopics.length && row.expectedStoreTopic) {
    expectedStoreTopics.push(
      row.expectedStoreTopic.startsWith("#")
        ? row.expectedStoreTopic
        : `#${row.expectedStoreTopic}`,
    );
  }
  const matchedStoreTopics = parseStoredStringArray(row.matchedStoreTopics);
  if (!matchedStoreTopics.length && row.matchedStoreTopic) {
    matchedStoreTopics.push(row.matchedStoreTopic);
  }
  const requiredStoreTopics = parseStoredStringArray(row.requiredStoreTopics);
  const matchedRequiredStoreTopics = parseStoredStringArray(
    row.matchedRequiredStoreTopics,
  );

  return (
    <div className={styles.decisionLayout}>
      <section
        className={`${styles.decisionHero} ${styles[`decisionHero_${conclusionTone}`]}`}
        aria-label="顶部结论"
      >
        <div className={styles.decisionHeroTopline}>
          <span
            className={`${styles.platformBadge} ${
              channel ? styles[`platformBadge_${channel}`] : ""
            }`}
          >
            <i aria-hidden="true" />
            渠道：{channelLabel}
          </span>
          <span className={styles.decisionEyebrow}>审核结论</span>
          <strong className={styles.decisionTitle}>{conclusion}</strong>
          {duplicateReaudit ? (
            <Tag color="orange">
              重复重审 · 历史 {duplicateReaudit.historicalCount} 次
            </Tag>
          ) : null}
        </div>
        {duplicateReaudit ? (
          <div className={styles.cellSecondary}>
            自动结果：{auditStatusText(duplicateReaudit.automaticResult)}；
            {reviews[0]
              ? `人工最终结果：${reviews[0].result === "PASSED" ? "通过" : reviews[0].result === "FAILED" ? "不通过" : "待确认"}`
              : "等待人工最终确认"}
          </div>
        ) : null}
        <div className={styles.decisionOwnership}>
          <div>
            <span>产品</span>
            <strong>{row.task.product.name || "—"}</strong>
          </div>
          <div>
            <span>活动</span>
            <strong>{row.task.campaign.name || "—"}</strong>
          </div>
          <div>
            <span>阶段</span>
            <strong>{productStageTopicLabel(row.task.productStage) || "—"}</strong>
          </div>
          <div className={styles.decisionSourceField}>
            <span>渠道</span>
            <strong>{channelLabel}</strong>
          </div>
          <div className={styles.decisionSourceField}>
            <span>平台</span>
            <strong>{platformLabel}</strong>
          </div>
          <div className={styles.decisionSourceField}>
            <span>店铺</span>
            <Tooltip title={storeName === "—" ? undefined : storeName}>
              <strong className={styles.storeName}>{storeName}</strong>
            </Tooltip>
          </div>
          <div>
            <span>订单编号</span>
            {orderNumber === "—" ? (
              <strong>—</strong>
            ) : (
              <Typography.Text
                className={styles.orderNumber}
                copyable={{ text: orderNumber, tooltips: ["复制订单编号", "已复制"] }}
              >
                {orderNumber}
              </Typography.Text>
            )}
          </div>
          <div>
            <span>发帖时间</span>
            <strong>
              {formatPlatformPublishedAt(
                row.note.publishedAt,
                row.note.publishedAtRaw,
              )}
            </strong>
          </div>
          <div>
            <span>实际审核时间</span>
            <strong>{formatAuditTime(row.auditedAt)}</strong>
          </div>
          {row.task.importRecord ? (
            <>
              <div>
                <span>导入文件</span>
                <Tooltip title={row.task.importRecord.fileName}>
                  <strong className={styles.storeName}>
                    {row.task.importRecord.fileName}
                  </strong>
                </Tooltip>
              </div>
              <div>
                <span>导入时间</span>
                <strong>{formatAuditTime(row.task.importRecord.createdAt)}</strong>
              </div>
              <div>
                <span>导入批次 ID</span>
                <Typography.Text copyable={{ text: row.task.importRecord.id }}>
                  {row.task.importRecord.id}
                </Typography.Text>
              </div>
            </>
          ) : null}
          <div className={styles.decisionTitleField}>
            <span>标题</span>
            <strong>{row.note.title || "未获取标题"}</strong>
          </div>
        </div>
        {!unavailable ? (
          <div className={styles.decisionMetrics}>
            <span>有效正文：{row.effectiveBodyLength ?? 0} 个字符</span>
            <span>
              图片数量：{row.imageCount === null ? "未能确认" : `${row.imageCount} 张`}
            </span>
            <span>
              公开状态：{publicStatusText(row.publicStatus)}
            </span>
          </div>
        ) : null}
      </section>

      <section className={styles.decisionSection} aria-label="失败原因">
        <h3>失败原因</h3>
        {failureReasons.length ? (
          <ul className={styles.failureReasonList}>
            {failureReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : (
          <div className={styles.decisionEmpty}>无异常</div>
        )}
      </section>

      <section className={styles.decisionSection} aria-label="审核明细">
        <h3>审核明细</h3>
        <div className={styles.auditDetailCards}>
          {unavailable ? (
            <article className={styles.auditDetailCard}>
              <h4>页面审核</h4>
              <strong>笔记不存在</strong>
            </article>
          ) : null}
          <article className={styles.auditDetailCard}>
            <h4>话题审核</h4>
            {unavailable ? (
              <strong>未审核</strong>
            ) : (
              <div className={styles.auditDetailList}>
                <div>
                  <span>结果</span>
                  <strong>
                    {matchedTopicCount} / {expectedTopicCount}{" "}
                    {topicNeedsReview
                      ? "待复核"
                      : topicCompliant
                        ? "合规"
                        : "异常"}
                  </strong>
                </div>
                {topicSummary.missing.length ? (
                  <div>
                    <span>缺少</span>
                    <strong>{topicSummary.missing.join(" / ")}</strong>
                  </div>
                ) : null}
                {topicSummary.stageCandidates.length ? (
                  <>
                    <div>
                      <span>阶段话题</span>
                      <strong>
                        {topicSummary.stageGroupMissing
                          ? "未命中"
                          : `已命中 ${topicSummary.matchedStageCandidates.join(" / ")}`}
                      </strong>
                    </div>
                    <div>
                      <span>要求阶段话题</span>
                      <strong>{topicSummary.stageCandidates.join(" / ")}</strong>
                    </div>
                  </>
                ) : null}
              </div>
            )}
          </article>

          <article className={styles.auditDetailCard}>
            <h4>图片审核</h4>
            {unavailable ? (
              <strong>未审核</strong>
            ) : (
              <div className={styles.auditDetailList}>
                <div>
                  <span>结果</span>
                  <strong>
                    {row.imageCount === null ? "未能确认" : `${row.imageCount} 张`}
                  </strong>
                </div>
                <div>
                  <span>状态</span>
                  <strong>
                    {["VIDEO", "VIDEO_NOTE"].includes(row.noteType) || row.imageStatus === "VIDEO_NOTE"
                      ? "视频笔记，不参与图片数量审核"
                      : row.imageStatus === "COMPLIANT"
                        ? "数量合规"
                        : row.imageStatus === "NON_COMPLIANT"
                          ? minimumImageCount === null
                            ? "数量不足"
                            : `数量不足，要求至少 ${minimumImageCount} 张`
                          : "待人工复核"}
                  </strong>
                </div>
              </div>
            )}
          </article>

          <article className={styles.auditDetailCard}>
            <h4>店铺话题审核</h4>
            {unavailable || row.storeTopicStatus === "NOT_CHECKED" ? (
              <strong>未审核</strong>
            ) : row.storeTopicStatus === "NOT_REQUIRED" ? (
              <strong>不适用</strong>
            ) : (
              <div className={styles.auditDetailList}>
                <div>
                  <span>导入店铺</span>
                  <strong>{row.task.storeName || "—"}</strong>
                </div>
                <div>
                  <span>匹配标准店铺</span>
                  <strong>{row.task.matchedStoreName || "未匹配"}</strong>
                </div>
                <div>
                  <span>可接受店铺话题</span>
                  <strong>
                    {expectedStoreTopics.length
                      ? expectedStoreTopics.map((topic) => (
                          <span key={topic} style={{ display: "block" }}>
                            {topic}
                          </span>
                        ))
                      : "无法确认"}
                  </strong>
                </div>
                <div>
                  <span>附加必需话题</span>
                  <strong>
                    {requiredStoreTopics.length
                      ? requiredStoreTopics.map((topic) => (
                          <span key={topic} style={{ display: "block" }}>
                            {topic}
                          </span>
                        ))
                      : "无"}
                  </strong>
                </div>
                <div>
                  <span>实际命中话题</span>
                  <strong>
                    {matchedStoreTopics.length || matchedRequiredStoreTopics.length
                      ? [...matchedStoreTopics, ...matchedRequiredStoreTopics].map((topic) => (
                          <span key={topic} style={{ display: "block" }}>
                            {topic}
                          </span>
                        ))
                      : "无"}
                  </strong>
                </div>
                {row.storeTopicStatus === "NON_COMPLIANT" &&
                !matchedStoreTopics.length ? (
                  <div>
                    <span>缺少可接受话题</span>
                    <strong>
                      {expectedStoreTopics.map((topic) => (
                        <span key={topic} style={{ display: "block" }}>
                          {topic}
                        </span>
                      ))}
                    </strong>
                  </div>
                ) : null}
                <div>
                  <span>状态</span>
                  <strong>
                    {row.storeTopicStatus === "COMPLIANT"
                      ? "合规"
                      : row.storeTopicStatus === "NON_COMPLIANT"
                        ? "不合规"
                        : "无法审核"}
                  </strong>
                </div>
                {row.storeTopicFailureReason ? (
                  <div>
                    <span>原因</span>
                    <strong>{row.storeTopicFailureReason}</strong>
                  </div>
                ) : null}
              </div>
            )}
          </article>

          {unavailable ? (
            <>
              <article className={styles.auditDetailCard}>
                <h4>正文审核</h4>
                <strong>未审核</strong>
              </article>
              <article className={styles.auditDetailCard}>
                <h4>公开状态</h4>
                <strong>无法确认</strong>
              </article>
            </>
          ) : null}

          {!unavailable ? (
            <>
              <article className={styles.auditDetailCard}>
                <h4>正文审核</h4>
                <div className={styles.auditDetailList}>
                  <div>
                    <span>有效正文</span>
                    <strong>{row.effectiveBodyLength ?? 0} 个字符</strong>
                  </div>
                  <div>
                    <span>状态</span>
                    <strong>
                      {row.bodyStatus === "UNKNOWN"
                        ? "待人工确认"
                        : row.bodyCompliant
                          ? "合规"
                          : "不合规"}
                    </strong>
                  </div>
                </div>
              </article>
              <article className={styles.auditDetailCard}>
                <h4>公开状态</h4>
                <div className={styles.auditDetailList}>
                  <div>
                    <span>状态</span>
                    <strong>
                      {publicStatusText(row.publicStatus)}
                    </strong>
                  </div>
                </div>
              </article>
              {basicRewardRule && basicReward ? (
                <article className={styles.auditDetailCard}>
                  <h4>基础奖励</h4>
                  <div className={styles.auditDetailList}>
                    <div>
                      <span>内容合规</span>
                      <strong>{auditStatusText(basicReward.contentStatus)}</strong>
                    </div>
                    <div>
                      <span>点赞数</span>
                      <strong>
                        {basicReward.likeCount ?? "无法确认"}
                      </strong>
                    </div>
                    <div>
                      <span>收藏数</span>
                      <strong>
                        {basicReward.favoriteCount ?? "无法确认"}
                      </strong>
                    </div>
                    <div>
                      <span>评论数</span>
                      <strong>
                        {basicReward.commentCount ?? "无法确认"}
                      </strong>
                    </div>
                    <div>
                      <span>合计互动数</span>
                      <strong>
                        {basicReward.totalCount ?? "无法确认"}
                      </strong>
                    </div>
                    <div>
                      <span>达成条件</span>
                      <strong>≥ {basicReward.minimumTotal ?? 10}</strong>
                    </div>
                    <div>
                      <span>基础奖励</span>
                      <strong>
                        {basicReward.interactionReadable === false
                          ? "待人工复核"
                          : basicReward.rewardPassed
                            ? "已达成"
                            : "未达成"}
                      </strong>
                    </div>
                    <div>
                      <span>最终审核结论</span>
                      <strong>{auditStatusText(basicReward.finalStatus)}</strong>
                    </div>
                  </div>
                </article>
              ) : null}
            </>
          ) : null}
        </div>
      </section>

      <section className={styles.decisionSection} aria-label="链接操作">
        <h3>链接操作</h3>
        <div className={styles.linkActionGroups}>
          <ResultDetailLink
            label="原链接"
            value={links.originalUrl}
            variant="actions"
            openText="打开原笔记"
            copyText="复制原链接"
          />
          {!unavailable ? (
            <ResultDetailLink
              label="最终链接"
              value={links.finalUrl}
              variant="actions"
              openText="打开最终链接"
              copyText="复制最终链接"
            />
          ) : null}
        </div>
      </section>

      <section className={styles.decisionSection} aria-label="人工复核记录">
        <h3>人工复核记录</h3>
        {reviews.length ? (
          <div className={styles.reviewList}>
            {reviews.map((review, index) => (
              <article
                className={styles.reviewItem}
                key={review.id || `${review.result}-${review.createdAt || index}`}
              >
                <div>
                  <span>复核人</span>
                  <strong>{review.reviewer?.displayName || "管理员"}</strong>
                </div>
                <div>
                  <span>复核结果</span>
                  <ReviewResult value={review.result} />
                </div>
                <div>
                  <span>复核时间</span>
                  <strong>
                    {review.createdAt
                      ? new Date(review.createdAt).toLocaleString("zh-CN")
                      : "-"}
                  </strong>
                </div>
                <div className={styles.reviewComment}>
                  <span>复核备注</span>
                  <strong>{review.comment || "无"}</strong>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className={styles.decisionEmpty}>暂无人工复核记录</div>
        )}
      </section>
    </div>
  );
}
