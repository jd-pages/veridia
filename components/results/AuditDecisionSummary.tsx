"use client";

import { Alert, Tag, Tooltip, Typography } from "antd";
import { productStageTopicLabel } from "@/lib/product-stage";
import { isUnavailableNoteResult } from "@/lib/result-display";
import { resultDetailLinks } from "@/lib/result-links";
import { parseStoredStringArray } from "@/lib/stored-json";
import { formatPlatformPublishedAt } from "@/lib/platform-published-at";
import {
  duplicateReauditMetadataFromNotes,
} from "@/lib/import-task-metadata";
import {
  formatOriginalPublishedAt,
} from "@/lib/xhs-original-published-at";
import {
  commercePlatformLabel,
  contentChannelLabel,
  formatAuditTime,
  resolveTaskChannel,
} from "@/lib/result-source";
import InteractionReward from "./InteractionReward";
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

export default function AuditDecisionSummary({
  row: listRow,
  detail,
}: {
  row: ResultRow;
  detail?: ResultDetail | null;
}) {
  // Detail is projected from this result's extraction; list note data is only a cache.
  const row = detail ?? listRow;
  const unavailable = isUnavailableNoteResult(row);
  const conclusion = row.presentation.conclusion.label;
  const conclusionTone = row.presentation.conclusion.tone;
  const failureReasons = row.presentation.failureReasons;
  const reviewReasons = row.presentation.reviewReasons;
  const topicSummary = row.presentation.topic;
  const expectedTopicCount = topicSummary.expectedCount;
  const matchedTopicCount = topicSummary.matchedCount;
  const topicNeedsReview = topicSummary.status === "NEEDS_REVIEW";
  const topicCompliant = topicSummary.status === "COMPLIANT";
  const topicUnavailable = topicSummary.status === "UNAVAILABLE";
  const links = resultDetailLinks(row);
  const minimumImageCount = row.presentation.image.minimumCount;
  const reviews = detail?.manualReviews || row.manualReviews;
  const duplicateReaudit = duplicateReauditMetadataFromNotes(row.task.notes);
  const basicRewardRule = row.ruleResults.find(
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
  const storeTopicNotRequired =
    row.storeTopicStatus === "NOT_REQUIRED" ||
    (row.task.storeMappingStatus === "MATCHED" &&
      expectedStoreTopics.length === 0 &&
      requiredStoreTopics.length === 0);
  const storeTopicNotApplicable =
    row.presentation.storeTopic.status === "NOT_APPLICABLE";

  return (
    <div className={styles.decisionLayout}>
      {row.evidenceStatus === "LEGACY_UNAVAILABLE" ? (
        <Alert
          type="warning"
          showIcon
          message="历史采集证据未能确认"
          description={row.evidenceMessage}
        />
      ) : null}
      {row.presentation.consistency.status !== "CONSISTENT" ? (
        <Alert
          type="warning"
          showIcon
          message={row.presentation.consistency.status === "RESULT_CONSISTENCY_VIOLATION"
            ? "结果一致性异常"
            : "历史审核明细不可用"}
          description={row.presentation.consistency.message}
        />
      ) : null}
      <InteractionReward snapshot={row} detail />
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
          {channel === "XIAOHONGSHU" ? (
            <div>
              <span>原始发布时间</span>
              <strong>
                {formatOriginalPublishedAt({
                  originalPublishedAt: row.note.originalPublishedAt ?? null,
                  originalPublishedAtStatus:
                    row.note.originalPublishedAtStatus ?? "UNCONFIRMED",
                })}
              </strong>
            </div>
          ) : null}
          <div>
            <span>平台显示时间</span>
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
            <div>
              <span>导入批次 ID</span>
              <Typography.Text copyable={{ text: row.task.importRecord.id }}>
                {row.task.importRecord.id}
              </Typography.Text>
            </div>
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
              {row.presentation.media.kind === "VIDEO"
                ? "作品类型：视频"
                : row.presentation.media.kind === "IMAGE_TEXT"
                  ? `图片数量：${row.presentation.media.imageCount === null ? "未能确认" : `${row.presentation.media.imageCount} 张`}`
                  : "图片 / 视频：作品类型无法确认"}
            </span>
            <span>
              公开状态：{row.presentation.publicDisplay.label}
            </span>
          </div>
        ) : null}
      </section>

      {failureReasons.length ? (
        <section className={styles.decisionSection} aria-label="失败原因">
          <h3>失败原因</h3>
          <ul className={styles.failureReasonList}>
            {failureReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {reviewReasons.length ? (
        <section className={styles.decisionSection} aria-label="待人工复核事项">
          <h3>待人工复核事项</h3>
          <ul className={styles.failureReasonList}>
            {reviewReasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        </section>
      ) : null}

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
            <h4>公开状态</h4>
            <strong>{row.presentation.publicDisplay.label}</strong>
          </article>

          <article className={styles.auditDetailCard}>
            <h4>话题审核</h4>
            {unavailable || topicUnavailable ? (
              <strong>{unavailable ? "未审核" : "历史审核明细不可用"}</strong>
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
            <h4>图片 / 视频审核</h4>
            {unavailable ? (
              <strong>未审核</strong>
            ) : (
              <div className={styles.auditDetailList}>
                {row.presentation.media.kind === "VIDEO" ? (
                  <div>
                    <span>作品类型</span>
                    <strong>视频</strong>
                  </div>
                ) : (
                  <div>
                    <span>结果</span>
                    <strong>
                      {row.presentation.media.imageCount === null
                        ? "未能确认"
                        : `${row.presentation.media.imageCount} 张`}
                    </strong>
                  </div>
                )}
                <div>
                  <span>状态</span>
                  <strong>
                    {row.presentation.image.status === "NON_COMPLIANT" && minimumImageCount !== null
                      ? `数量不足，要求至少 ${minimumImageCount} 张`
                      : row.presentation.image.label}
                  </strong>
                </div>
              </div>
            )}
          </article>

          <article className={styles.auditDetailCard}>
            <h4>店铺话题审核</h4>
            {storeTopicNotApplicable ? (
              <strong>不适用</strong>
            ) : storeTopicNotRequired ? (
              <div className={styles.auditDetailList}>
                <div>
                  <span>导入店铺</span>
                  <strong>{row.task.storeName || "—"}</strong>
                </div>
                <div>
                  <span>店铺映射</span>
                  <strong>
                    {row.task.matchedStoreName
                      ? `已匹配：${row.task.matchedStoreName}`
                      : "未匹配"}
                  </strong>
                </div>
                <div>
                  <span>店铺话题要求</span>
                  <strong>不要求</strong>
                </div>
              </div>
            ) : unavailable || row.storeTopicStatus === "NOT_CHECKED" ? (
              <strong>未审核</strong>
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
                {topicSummary.anyCandidates.length ? (
                  <>
                    <div>
                      <span>热门话题</span>
                      <strong>
                        已命中 {topicSummary.matchedAnyCandidates.length} / 要求 {topicSummary.anyMinimum}
                      </strong>
                    </div>
                    <div>
                      <span>已命中热门话题</span>
                      <strong>{topicSummary.matchedAnyCandidates.join(" / ") || "无"}</strong>
                    </div>
                    <div>
                      <span>未命中候选</span>
                      <strong>{topicSummary.unmatchedAnyCandidates.join(" / ") || "无"}</strong>
                    </div>
                  </>
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
                      {row.presentation.body.label}
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
