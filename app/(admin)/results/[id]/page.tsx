"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Timeline,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  EditOutlined,
  LinkOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { useParams, useRouter } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import StatusTag from "@/components/StatusTag";
import ExtractionEvidencePanel from "@/components/results/ExtractionEvidencePanel";
import { apiFetch, parseJsonArray } from "@/lib/client";
import {
  productStageTopicLabel,
  stageTopicsFromRuleSnapshot,
} from "@/lib/product-stage";
import { normalizeTopic } from "@/lib/topic";
import { classifyTopicClickability } from "@/lib/topic-clickability";
import {
  aiRelevanceLabels,
  aiStatusLabels,
  auditResultLabels,
} from "@/lib/zh-CN";
import {
  auditDetailEvidenceLabel,
  auditDetailFailureReasonLabel,
  auditDetailJsonForDisplay,
  auditDetailStatusLabel,
  auditDetailTextLabel,
  filterAuditDetailReasons,
  filterAuditDetailRules,
} from "@/lib/audit-detail-visibility";

interface Product { id: string; name: string; code: string }
interface Campaign { id: string; name: string; productId: string; month: string }
interface Detail {
  id: string;
  ruleVersion: number;
  ruleSnapshot: string;
  pageStatus: string;
  bodyStatus: string;
  effectiveBodyLength: number;
  bodyCompliant: boolean;
  noteType: string;
  imageExtractionStatus: string;
  imageStatus: string;
  imageCount: number;
  imageCompliant: boolean;
  topicsCompliant: boolean;
  clickableCompliant: boolean;
  missingTopics: string;
  forbiddenTopics: string;
  autoStatus: string;
  publicStatus: string;
  retentionStatus: string;
  retentionDueAt: string | null;
  failureReasons: string;
  aiStatus: string;
  aiRelevance: string | null;
  aiReason: string | null;
  auditedAt: string;
  currentStageGroup: {
    key: string;
    label: string;
    requiredTopic: string;
    requireBodyStage: boolean;
    ruleVersion: string;
  } | null;
  task: {
    id: string;
    status: string;
    url: string;
    finalUrl: string | null;
    failureCode: string | null;
    failureMessage: string | null;
    failureEvidence: string | null;
    attempts: number;
    productStage: string | null;
    product: Product;
    campaign: Campaign;
  };
  note: {
    id: string;
    platformNoteId: string | null;
    url: string;
    title: string | null;
    body: string | null;
    authorName: string | null;
    publishedAt: string | null;
    isPublic: boolean | null;
    lastCapturedAt: string;
    topics: Array<{
      id: string;
      displayText: string;
      isLinkElement: boolean;
      hasHref: boolean;
      href: string | null;
      textColor: string | null;
      styleFeature: boolean;
      isClickable: boolean;
      domPath: string | null;
    }>;
    extractions: Array<{ id: string; rawData: string; extractedAt: string; adapterName: string; adapterVersion: string }>;
  };
  ruleResults: Array<{
    id: string;
    ruleKey: string;
    ruleName: string;
    expectedValue: string;
    actualValue: string;
    passed: boolean;
    failureReason: string | null;
    evidence: string;
  }>;
  manualReviews: Array<{
    id: string;
    result: string;
    comment: string | null;
    createdAt: string;
    reviewer: { displayName: string; username: string };
  }>;
  operationLogs: Array<{
    id: string;
    action: string;
    summary: string;
    createdAt: string;
    user: { displayName: string } | null;
  }>;
}

export default function ResultDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const selectedProduct = Form.useWatch("productId", form);

  const load = useCallback(async () => {
    try {
      const [result, productData, campaignData] = await Promise.all([
        apiFetch<Detail>(`/api/results/${params.id}`),
        apiFetch<Product[]>("/api/products"),
        apiFetch<Campaign[]>("/api/campaigns"),
      ]);
      setDetail(result);
      setProducts(productData);
      setCampaigns(campaignData);
    } catch (error) {
      if (error instanceof Error && error.message === "审核结果不存在") {
        message.warning("该审核结果已删除或不存在");
        router.replace("/results");
        return;
      }
      message.error(error instanceof Error ? error.message : "加载详情失败");
    }
  }, [message, params.id, router]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!detail) {
    return <div style={{ minHeight: 420, display: "grid", placeItems: "center" }}><Spin size="large" /></div>;
  }
  const reasons = filterAuditDetailReasons(
    parseJsonArray(detail.failureReasons).filter(
      (reason) =>
        !/首图|视觉|产品实拍|合照|罐体|平台导向|图片内容/u.test(reason),
    ),
  );
  const processingFailed = [
    "FAILED",
    "READ_FAILED",
    "LOGIN_EXPIRED",
  ].includes(detail.task.status);
  const displayedRuleResults = filterAuditDetailRules(
    detail.ruleResults.filter(
      (rule) =>
        !/首图|视觉|产品实拍|合照|罐体|平台导向|图片内容/u.test(rule.ruleName),
    ),
  );
  const productStageLabel = productStageTopicLabel(detail.task.productStage);
  const pageUnavailable = ["NOT_FOUND", "DELETED"].includes(detail.pageStatus);
  const snapshotStageTopics = stageTopicsFromRuleSnapshot(detail.ruleSnapshot);
  const requiredStageTopics = pageUnavailable
    ? []
    : snapshotStageTopics.length
      ? snapshotStageTopics
      : processingFailed && detail.currentStageGroup?.requiredTopic
        ? [detail.currentStageGroup.requiredTopic]
        : [];
  const stageTopicMatches = requiredStageTopics.flatMap((requiredTopic) =>
    detail.note.topics
      .filter(
        (topic) =>
          normalizeTopic(topic.displayText) === normalizeTopic(requiredTopic),
      )
      .map((topic) => ({
        topic,
        clickability: classifyTopicClickability(topic, {
          pageUrl: detail.note.url,
        }),
      })),
  );
  const stageTopicMatch =
    stageTopicMatches.find((item) => item.clickability === "CLICKABLE") ||
    stageTopicMatches[0];
  const stageTopicClickability = stageTopicMatch?.clickability || "UNKNOWN";
  const missingRequiredTopics = parseJsonArray(detail.missingTopics).filter(
    (expected) =>
      !detail.note.topics.some(
        (topic) =>
          normalizeTopic(topic.displayText) === normalizeTopic(expected),
      ),
  );
  const clickableNotApplicable = missingRequiredTopics.length > 0;
  const bodyUnavailable = detail.bodyStatus === "UNKNOWN";

  return (
    <>
      <PageHeader
        title="审核详情"
        description={`笔记 ${detail.note.platformNoteId || "未识别ID"} · 规则版本 v${detail.ruleVersion}`}
        actions={
          <Space>
            <StatusTag
              value={detail.autoStatus}
              domain="audit"
              label={auditDetailStatusLabel(detail.autoStatus, "audit")}
            />
            <Button
              type="primary"
              icon={<EditOutlined />}
              onClick={() => {
                setOpen(true);
                window.setTimeout(() => {
                  form.resetFields();
                  form.setFieldsValue({
                    productId: detail.task.product.id,
                    campaignId: detail.task.campaign.id,
                    result: detail.manualReviews[0]?.result || "NEEDS_REVIEW",
                    comment: detail.manualReviews[0]?.comment || "",
                  });
                }, 0);
              }}
            >
              人工复核
            </Button>
          </Space>
        }
      />
      {reasons.length && processingFailed ? (
        <Alert
          type="warning"
          showIcon
          message="处理失败，待人工复核"
          description={reasons.join("；")}
          style={{ marginBottom: 16 }}
        />
      ) : reasons.length ? (
        <Alert
          type="error"
          showIcon
          message="自动审核未通过"
          description={reasons.join("；")}
          style={{ marginBottom: 16 }}
        />
      ) : detail.autoStatus === "NEEDS_REVIEW" ? (
        <Alert
          type="warning"
          showIcon
          message={
            detail.imageStatus === "IMAGES_READ_FAILED"
              ? "图片数量读取失败，待人工复核"
              : "存在需要人工确认的审核项"
          }
          description="技术读取失败不会生成内容不合规结论。"
          style={{ marginBottom: 16 }}
        />
      ) : (
        <Alert
          type="success"
          showIcon
          message="全部固定规则审核通过"
          style={{ marginBottom: 16 }}
        />
      )}
      <Row gutter={[14, 14]}>
        <Col xs={24} xl={15}>
          <Card className="surface-card" title="笔记基础信息">
            <Descriptions column={2} bordered size="small">
              <Descriptions.Item label="笔记ID">{detail.note.platformNoteId || "-"}</Descriptions.Item>
              <Descriptions.Item label="页面状态"><StatusTag value={detail.pageStatus} label={auditDetailStatusLabel(detail.pageStatus)} /></Descriptions.Item>
              <Descriptions.Item label="产品">{detail.task.product.name}</Descriptions.Item>
              <Descriptions.Item label="活动">{detail.task.campaign.name}</Descriptions.Item>
              <Descriptions.Item label="产品阶段话题" span={2}>
                {productStageLabel}
              </Descriptions.Item>
              <Descriptions.Item label="链接" span={2}>
                <a href={detail.note.url} target="_blank" rel="noreferrer" style={{ color: "#175cd3" }}>
                  {detail.note.url}
                </a>
              </Descriptions.Item>
              <Descriptions.Item label="标题" span={2}>{detail.note.title || "-"}</Descriptions.Item>
            </Descriptions>
          </Card>
          <Card className="surface-card" title="笔记正文" style={{ marginTop: 14 }}>
            <Typography.Paragraph style={{ whiteSpace: "pre-wrap", lineHeight: 1.9, marginBottom: 0 }}>
              {detail.note.body?.trim() || (
                <span className="danger-text">
                  {bodyUnavailable ? "未提取到正文 / 待人工确认" : "正文为空"}
                </span>
              )}
            </Typography.Paragraph>
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card className="surface-card" title="综合判断">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="处理状态">
                <StatusTag value={detail.task.status} domain="process" label={auditDetailStatusLabel(detail.task.status, "process")} />
              </Descriptions.Item>
              <Descriptions.Item label="审核结论">
                <StatusTag value={detail.autoStatus} domain="audit" label={auditDetailStatusLabel(detail.autoStatus, "audit")} />
              </Descriptions.Item>
              <Descriptions.Item label="异常分类">
                {detail.task.failureCode
                  ? auditDetailFailureReasonLabel(detail.task.failureCode)
                  : "无异常"}
              </Descriptions.Item>
              <Descriptions.Item label="失败原因">
                {reasons.join("；") ||
                  (detail.task.failureMessage
                    ? auditDetailTextLabel(detail.task.failureMessage)
                    : "无异常")}
              </Descriptions.Item>
              <Descriptions.Item label="尝试次数">
                {detail.task.attempts}
              </Descriptions.Item>
              <Descriptions.Item label="正文">
                {bodyUnavailable ? (
                  <Tag color="orange">未提取到正文 / 待人工确认</Tag>
                ) : (
                  <Tag color={detail.bodyCompliant ? "green" : "red"}>
                    {detail.effectiveBodyLength} 个有效字符 ·{" "}
                    {detail.bodyCompliant ? "合规" : "不合规"}
                  </Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="要求阶段话题">
                {requiredStageTopics.length
                  ? `${requiredStageTopics.join(" 或 ")}（任一命中）`
                  : pageUnavailable
                    ? "页面失效，不执行阶段话题审核"
                    : "当前活动未配置阶段话题规则"}
              </Descriptions.Item>
              <Descriptions.Item label="阶段话题命中">
                {requiredStageTopics.length ? (
                  <Tag color={stageTopicMatch ? "green" : "red"}>
                    {stageTopicMatch
                      ? `已命中 ${normalizeTopic(stageTopicMatch.topic.displayText)}`
                      : "否"}
                  </Tag>
                ) : (
                  <Tag>不适用</Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="阶段话题可点击">
                {!requiredStageTopics.length || !stageTopicMatch ? (
                  <Tag>不适用</Tag>
                ) : (
                  <Tag
                    color={
                      stageTopicClickability === "CLICKABLE"
                        ? "green"
                        : stageTopicClickability === "UNKNOWN"
                          ? "orange"
                          : "red"
                    }
                  >
                    {stageTopicClickability === "CLICKABLE"
                      ? "是"
                      : stageTopicClickability === "UNKNOWN"
                        ? "待人工确认"
                        : "否"}
                  </Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="笔记类型">
                <StatusTag value={detail.noteType} label={auditDetailStatusLabel(detail.noteType)} />
              </Descriptions.Item>
              <Descriptions.Item label="图片数量">
                {detail.imageStatus === "COMPLIANT" ||
                detail.imageStatus === "NON_COMPLIANT" ? (
                  <Space>
                    <span>{detail.imageCount} 张</span>
                    <StatusTag value={detail.imageStatus} label={auditDetailStatusLabel(detail.imageStatus)} />
                  </Space>
                ) : (
                  <StatusTag value={detail.imageStatus} label={auditDetailStatusLabel(detail.imageStatus)} />
                )}
              </Descriptions.Item>
              <Descriptions.Item label="话题">
                <Tag color={detail.topicsCompliant ? "green" : "red"}>{detail.topicsCompliant ? "合规" : "不合规"}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="蓝色可点击">
                {clickableNotApplicable ? (
                  <Tag>不适用（要求话题缺失）</Tag>
                ) : (
                  <Tag color={detail.clickableCompliant ? "green" : "red"}>
                    {detail.clickableCompliant ? "正常" : "异常"}
                  </Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="当前公开状态">
                <StatusTag value={detail.publicStatus} label={auditDetailStatusLabel(detail.publicStatus)} />
              </Descriptions.Item>
              <Descriptions.Item label="智能辅助">
                <Space direction="vertical" size={2}>
                  <Tag>
                    {aiStatusLabels[detail.aiStatus] || "状态未知"} /{" "}
                    {aiRelevanceLabels[detail.aiRelevance || "UNKNOWN"] ||
                      "未判断"}
                  </Tag>
                  <span className="muted">{detail.aiReason || "未执行"}</span>
                </Space>
              </Descriptions.Item>
            </Descriptions>
          </Card>
          <Card className="surface-card" title="人工复核记录" style={{ marginTop: 14 }}>
            {detail.manualReviews.length ? (
              <Timeline
                items={detail.manualReviews.map((review) => ({
                  color: review.result === "PASSED" ? "green" : review.result === "FAILED" ? "red" : "gray",
                  children: (
                    <>
                      <Space><StatusTag value={review.result} domain="audit" /><strong>{review.reviewer.displayName}</strong></Space>
                      <div className="muted">{new Date(review.createdAt).toLocaleString("zh-CN")}</div>
                      <div>{review.comment ? auditDetailTextLabel(review.comment) : "无意见"}</div>
                    </>
                  ),
                }))}
              />
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未人工复核" />}
          </Card>
        </Col>
      </Row>
      <div style={{ marginTop: 14 }}>
        <ExtractionEvidencePanel
          rawData={detail.note.extractions[0]?.rawData}
          failureEvidence={detail.task.failureEvidence}
        />
      </div>
      <Card className="surface-card" title="识别出的全部话题与页面元素状态" style={{ marginTop: 14 }}>
        <Alert
          type="info"
          showIcon
          message="下方仅展示页面中已识别到的话题状态；缺少的要求话题不会出现在此列表中。"
          style={{ marginBottom: 12 }}
        />
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={detail.note.topics}
          scroll={{ x: 900 }}
          columns={[
            { title: "显示文字", dataIndex: "displayText", width: 180, render: (value) => <Tag color="blue">{value}</Tag> },
            { title: "链接元素", dataIndex: "isLinkElement", width: 100, render: (value) => value ? "是" : "否" },
            { title: "存在跳转地址", dataIndex: "hasHref", width: 120, render: (value) => value ? "是" : "否" },
            { title: "样式特征", dataIndex: "styleFeature", width: 100, render: (value) => value ? "符合" : "不符合" },
            { title: "文字颜色", dataIndex: "textColor", width: 160 },
            {
              title: "最终判断",
              dataIndex: "isClickable",
              width: 150,
              render: (value) => value
                ? <Tag color="green" icon={<CheckCircleOutlined />}>有效可点击话题</Tag>
                : <Tag color="red" icon={<StopOutlined />}>无效</Tag>,
            },
            {
              title: "跳转地址",
              dataIndex: "href",
              ellipsis: true,
              render: (value) => value ? <Space><LinkOutlined /><span>{value}</span></Space> : "-",
            },
          ]}
        />
      </Card>
      <Card className="surface-card" title="逐条规则结果" style={{ marginTop: 14 }}>
        <Table
          rowKey="id"
          pagination={false}
          dataSource={displayedRuleResults}
          scroll={{ x: 1000 }}
          columns={[
            { title: "规则名称", dataIndex: "ruleName", width: 240 },
            { title: "期望值", dataIndex: "expectedValue", width: 260 },
            { title: "实际值", dataIndex: "actualValue", width: 240, render: (value) => auditDetailTextLabel(value) },
            { title: "结果", dataIndex: "passed", width: 100, render: (value) => <Tag color={value ? "green" : "red"}>{value ? "通过" : "不通过"}</Tag> },
            { title: "不通过原因", dataIndex: "failureReason", width: 280, render: (value) => value ? <span className="danger-text">{auditDetailFailureReasonLabel(value)}</span> : "-" },
            {
              title: "审核证据",
              dataIndex: "evidence",
              render: (value) => {
                const localizedEvidence = auditDetailEvidenceLabel(value);
                return (
                  <Typography.Text code>
                    {localizedEvidence.slice(0, 200)}
                    {localizedEvidence.length > 200 ? "…" : ""}
                  </Typography.Text>
                );
              },
            },
          ]}
        />
      </Card>
      <Row gutter={[14, 14]} style={{ marginTop: 14 }}>
        <Col xs={24} xl={15}>
          <Collapse
            className="surface-card"
            items={[
              {
                key: "snapshot",
                label: "本次使用的规则快照（内部技术字段）",
                children: <pre style={{ whiteSpace: "pre-wrap" }}>{auditDetailJsonForDisplay(detail.ruleSnapshot)}</pre>,
              },
              ...detail.note.extractions.map((extraction, index) => ({
                key: extraction.id,
                label: `原始提取数据 ${index + 1}（内部技术字段）· 提取器版本 ${extraction.adapterVersion}`,
                children: <pre style={{ whiteSpace: "pre-wrap" }}>{auditDetailJsonForDisplay(extraction.rawData)}</pre>,
              })),
            ]}
          />
        </Col>
        <Col xs={24} xl={9}>
          <Card className="surface-card" title="操作日志">
            {detail.operationLogs.length ? (
              <Timeline items={detail.operationLogs.map((log) => ({
                children: (
                  <>
                    <strong>{auditDetailTextLabel(log.summary)}</strong>
                    <div className="muted">{log.user?.displayName || "系统"} · {new Date(log.createdAt).toLocaleString("zh-CN")}</div>
                  </>
                ),
              }))} />
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无关联日志" />}
          </Card>
        </Col>
      </Row>
      <Modal
        title="人工复核"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        okText="保存复核结论"
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values) => {
            await apiFetch(`/api/results/${detail.id}/review`, {
              method: "POST",
              body: JSON.stringify(values),
            });
            message.success("人工复核已保存，自动审核结果保持不变");
            setOpen(false);
            void load();
          }}
        >
          <Form.Item name="productId" label="产品归属" rules={[{ required: true }]}>
            <Select
              options={products.map((item) => ({ value: item.id, label: item.name }))}
              onChange={() => form.setFieldValue("campaignId", undefined)}
            />
          </Form.Item>
          <Form.Item name="campaignId" label="活动归属" rules={[{ required: true }]}>
            <Select options={campaigns.filter((item) => item.productId === selectedProduct).map((item) => ({ value: item.id, label: item.name }))} />
          </Form.Item>
          <Form.Item name="result" label="人工审核结果" rules={[{ required: true }]}>
            <Select options={[
              { value: "PASSED", label: auditResultLabels.PASSED },
              { value: "FAILED", label: auditResultLabels.FAILED },
              {
                value: "NEEDS_REVIEW",
                label: auditResultLabels.NEEDS_REVIEW,
              },
            ]} />
          </Form.Item>
          <Form.Item name="comment" label="人工审核意见">
            <Input.TextArea rows={4} placeholder="说明判断依据或待处理事项" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
