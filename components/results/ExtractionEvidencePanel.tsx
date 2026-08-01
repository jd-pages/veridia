"use client";

import { Alert, Card, Descriptions, Empty, Space, Tag, Typography } from "antd";

interface Candidate {
  value?: string;
  displayText?: string;
  source?: string;
  groupKey?: string;
  url?: string | null;
  href?: string | null;
  hasHref?: boolean;
  isLinkElement?: boolean;
  domPath?: string | null;
}

interface PageEvidence {
  originalUrl?: string;
  finalUrl?: string;
  pageTitle?: string;
  pageType?: string;
  visibleTextPreview?: string;
  visibleTextLength?: number;
  htmlLength?: number;
  noteIdCandidates?: Candidate[];
  titleCandidates?: Candidate[];
  bodyCandidates?: Candidate[];
  topicCandidates?: Candidate[];
  imageCandidates?: Candidate[];
  loginEvidence?: string[];
  responseSummaries?: Array<{
    path?: string;
    status?: number;
    code?: string | number | null;
    message?: string | null;
  }>;
  screenshotSaved?: boolean;
  screenshotPath?: string | null;
  htmlSummary?: unknown;
  domSummary?: unknown;
  redirectChain?: string[];
}

function parseEvidence(value?: string | null): PageEvidence | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as PageEvidence & {
      pageEvidence?: PageEvidence;
    };
    const candidate = parsed.pageEvidence || parsed;
    return candidate.finalUrl ||
      candidate.pageTitle ||
      candidate.visibleTextPreview ||
      candidate.noteIdCandidates ||
      candidate.bodyCandidates ||
      candidate.topicCandidates ||
      candidate.imageCandidates
      ? candidate
      : null;
  } catch {
    return null;
  }
}

function candidates(value?: Candidate[]) {
  return value || [];
}

function candidateText(item: Candidate) {
  return item.value || item.displayText || item.url || item.groupKey || "未命名候选";
}

function safeDisplayUrl(value?: string) {
  if (!value) return "未记录";
  try {
    const parsed = new URL(value);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|sign|signature|share|uuid|code|verify|secret|auth/iu.test(key)) {
        parsed.searchParams.set(key, "[已隐藏]");
      }
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

export default function ExtractionEvidencePanel({
  rawData,
  failureEvidence,
}: {
  rawData?: string | null;
  failureEvidence?: string | null;
}) {
  const evidence = parseEvidence(rawData) || parseEvidence(failureEvidence);
  if (!evidence) {
    return (
      <Card className="surface-card" title="自动取证证据">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="本次旧记录没有保存页面证据；重新审核后将保存完整取证信息。"
        />
      </Card>
    );
  }

  const noteIds = candidates(evidence.noteIdCandidates);
  const bodies = candidates(evidence.bodyCandidates);
  const topics = candidates(evidence.topicCandidates);
  const images = candidates(evidence.imageCandidates);

  return (
    <Card className="surface-card" title="自动取证证据">
      {evidence.loginEvidence?.length ? (
        <Alert
          type="warning"
          showIcon
          message="页面访问状态依据"
          description={evidence.loginEvidence.join("；")}
          style={{ marginBottom: 14 }}
        />
      ) : null}
      <Descriptions bordered size="small" column={2}>
        <Descriptions.Item label="原始输入链接" span={2}>
          <Typography.Text copyable>{safeDisplayUrl(evidence.originalUrl)}</Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="最终 URL" span={2}>
          <Typography.Text copyable>{safeDisplayUrl(evidence.finalUrl)}</Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="页面 title">
          {evidence.pageTitle || "未识别"}
        </Descriptions.Item>
        <Descriptions.Item label="命中页面类型">
          {evidence.pageType || "未识别"}
        </Descriptions.Item>
        <Descriptions.Item label="HTML 长度">
          {evidence.htmlLength ?? 0} 字符
        </Descriptions.Item>
        <Descriptions.Item label="页面可见文本长度">
          {evidence.visibleTextLength ?? 0} 字符
        </Descriptions.Item>
        <Descriptions.Item label="笔记 ID 候选" span={2}>
          {noteIds.length ? (
            <Space wrap>
              {noteIds.map((item, index) => (
                <Tag key={`${candidateText(item)}-${index}`}>
                  {candidateText(item)} · {item.source || "未知来源"}
                </Tag>
              ))}
            </Space>
          ) : (
            "未识别到候选"
          )}
        </Descriptions.Item>
        <Descriptions.Item label="正文候选" span={2}>
          {bodies.length ? (
            <Space direction="vertical" size={8} style={{ width: "100%" }}>
              {bodies.slice(0, 10).map((item, index) => (
                <div key={`${item.source || "body"}-${index}`}>
                  <Tag>{item.source || "未知来源"}</Tag>
                  <Typography.Paragraph
                    ellipsis={{ rows: 4, expandable: true, symbol: "展开" }}
                    style={{ margin: "6px 0 0", whiteSpace: "pre-wrap" }}
                  >
                    {candidateText(item)}
                  </Typography.Paragraph>
                </div>
              ))}
            </Space>
          ) : (
            "未识别到正文候选"
          )}
        </Descriptions.Item>
        <Descriptions.Item label="话题候选" span={2}>
          {topics.length ? (
            <Space wrap>
              {topics.slice(0, 100).map((item, index) => (
                <Tag
                  color={item.isLinkElement && item.hasHref ? "blue" : "default"}
                  key={`${candidateText(item)}-${index}`}
                >
                  {candidateText(item)} · {item.source || "未知来源"}
                  {item.isLinkElement && item.hasHref ? " · 可点击候选" : " · 文本候选"}
                </Tag>
              ))}
            </Space>
          ) : (
            "未识别到话题候选"
          )}
        </Descriptions.Item>
        <Descriptions.Item label="图片候选" span={2}>
          {images.length ? (
            <Space direction="vertical" size={4} style={{ width: "100%" }}>
              {images.slice(0, 100).map((item, index) => (
                <Typography.Text key={`${item.groupKey || "image"}-${index}`}>
                  {index + 1}. {item.source || "未知来源"} · {item.groupKey || "未分组"}
                  {item.url ? ` · ${item.url}` : ""}
                </Typography.Text>
              ))}
            </Space>
          ) : (
            "未识别到图片候选"
          )}
        </Descriptions.Item>
        <Descriptions.Item label="页面可见文本前 1000 字" span={2}>
          <Typography.Paragraph
            style={{ margin: 0, whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto" }}
          >
            {evidence.visibleTextPreview || "未读取到页面可见文本"}
          </Typography.Paragraph>
        </Descriptions.Item>
        <Descriptions.Item label="失败截图">
          {evidence.screenshotSaved
            ? evidence.screenshotPath || "已保存"
            : "未保存或本次无需截图"}
        </Descriptions.Item>
        <Descriptions.Item label="接口取证">
          {evidence.responseSummaries?.length
            ? evidence.responseSummaries
                .map(
                  (item) =>
                    `${item.path || "接口"} · HTTP ${item.status ?? "-"} · ${item.code ?? "无代码"}${
                      item.message ? ` · ${item.message}` : ""
                    }`,
                )
                .join("；")
            : "无接口摘要"}
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}
