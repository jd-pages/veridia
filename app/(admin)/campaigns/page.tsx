"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Drawer,
  Form,
  Input,
  List,
  Modal,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Tabs,
  Upload,
} from "antd";
import {
  DownloadOutlined,
  EyeOutlined,
  InboxOutlined,
  ReloadOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import type { UploadFile } from "antd";
import dayjs from "dayjs";
import PageHeader from "@/components/PageHeader";
import StatusTag from "@/components/StatusTag";
import { apiFetch } from "@/lib/client";
import { productStageTopicLabel } from "@/lib/product-stage";
import { topicCategoryLabels } from "@/lib/zh-CN";
import type { SessionUser } from "@/lib/auth";
import { canAccessBusiness } from "@/lib/permissions";
import StoreTopicRulesPanel from "@/components/campaigns/StoreTopicRulesPanel";

interface Product {
  id: string;
  code: string | null;
  name: string;
  brandName: string;
  seriesName: string | null;
  contentDirection?: string | null;
  aliases?: Array<{ id: string; alias: string }>;
}

interface TopicRule {
  id: string;
  productId: string | null;
  product: Product | null;
  topic: string;
  topicCategory: string;
  applicableStage: string | null;
  milkType: string | null;
  exactMatch: boolean;
  clickableRequired: boolean;
  ruleType: string;
  minCount: number;
}

interface Campaign {
  id: string;
  name: string;
  month: string;
  year: number | null;
  startDate: string;
  endDate: string;
  minImageCount: number;
  minBodyLength: number;
  publicRequired: boolean;
  retentionDays: number;
  rewardDescription: string | null;
  customerRegistrationNotes: string | null;
  ruleVersion: number;
  status: string;
  product: Product | null;
  products: Array<{ product: Product }>;
  topicRules?: TopicRule[];
  brandNames?: string[];
  _count: { topicRules: number };
}

interface ImportMetadata {
  campaignName: string;
  month: string;
  startDate: string;
  endDate: string;
}

interface ImportPreview {
  sourceFormat: "RAW_CAMPAIGN" | "STANDARD_TEMPLATE";
  campaign: {
    name: string;
    month: string;
    startDate: string;
    minImageCount: number;
    endDate: string;
    minBodyLength: number;
    publicRequired: boolean;
    retentionDays: number;
    rewardDescription: string;
    customerRegistrationNotes: string;
  };
  products: Array<{
    name: string;
    seriesName: string;
    aliases: string[];
    contentDirection: string;
  }>;
  topicRules: Array<{
    productName: string | null;
    applicableStage: string | null;
    milkType: string | null;
    topic: string;
    topicCategory: string;
    exactMatch: boolean;
    clickableRequired: boolean;
  }>;
  diagnostics: {
    unrecognizedCells: string[];
    missingProductNames: string[];
    missingStages: string[];
    duplicateTopics: string[];
    irregularTopics: string[];
    unrecognizedProductImages: string[];
    corrections: string[];
  };
  counts: {
    campaigns: number;
    products: number;
    topicRules: number;
    unrecognizedCells: number;
    missingProductNames: number;
    missingStages: number;
    duplicateTopics: number;
    irregularTopics: number;
    unrecognizedProductImages: number;
  };
  changes: {
    create: { campaigns: number; products: string[]; topicRules: number };
    update: { campaigns: number; products: string[]; topicRules: number };
  };
}

const defaultMetadata: ImportMetadata = {
  campaignName: "爱他美2026年7月小红书种草审核",
  month: "2026-07",
  startDate: "2026-07-01",
  endDate: "2026-07-31",
};

export default function CampaignsPage() {
  const { message } = App.useApp();
  const [items, setItems] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [detail, setDetail] = useState<Campaign | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [importForm] = Form.useForm<ImportMetadata>();
  const [currentRole, setCurrentRole] = useState<SessionUser["role"] | null>(
    null,
  );
  const [activeSection, setActiveSection] = useState("campaigns");
  const canManageBusiness = canAccessBusiness(currentRole);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await apiFetch<Campaign[]>("/api/campaigns"));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "加载活动失败");
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
    void apiFetch<SessionUser | null>("/api/auth/me").then((user) =>
      setCurrentRole(user?.role || null),
    );
  }, [load]);

  const submitImport = async (commit: boolean) => {
    const file = fileList[0]?.originFileObj;
    if (!file) {
      message.warning("请先选择规则 Excel 文件");
      return;
    }
    const metadata = await importForm.validateFields();
    if (commit) setCommitting(true);
    else setPreviewing(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("commit", String(commit));
      formData.append("metadata", JSON.stringify(metadata));
      const result = await apiFetch<ImportPreview & { imported?: unknown }>(
        "/api/rule-import",
        { method: "POST", body: formData },
      );
      setPreview(result);
      if (commit) {
        message.success("活动规则已确认写入数据库");
        setImportOpen(false);
        setPreview(null);
        setFileList([]);
        await load();
      } else {
        message.success("预检查完成，请核对后再确认导入");
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "规则 Excel 处理失败");
    } finally {
      setPreviewing(false);
      setCommitting(false);
    }
  };

  const openDetail = async (id: string) => {
    setDetailLoading(true);
    try {
      setDetail(await apiFetch<Campaign>(`/api/campaigns/${id}`));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "加载活动详情失败");
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <>
      <PageHeader
        title="活动与规则"
        description={activeSection === "campaigns"
          ? "原始横向活动表先预检查，再转换为产品、段位和话题的标准规则"
          : "独立维护各成交平台的标准店铺名称和必带可点击店铺话题"}
        actions={
          activeSection === "campaigns" ? <Space wrap>
            <Button
              icon={<DownloadOutlined />}
              onClick={() => window.open("/api/rule-import/template", "_blank")}
            >
              下载标准模板
            </Button>
            {canManageBusiness && (
              <Button
                type="primary"
                icon={<UploadOutlined />}
                onClick={() => {
                  setImportOpen(true);
                  setPreview(null);
                  importForm.setFieldsValue(defaultMetadata);
                }}
              >
                导入活动规则
              </Button>
            )}
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新
            </Button>
          </Space> : null
        }
      />

      <Tabs
        activeKey={activeSection}
        onChange={setActiveSection}
        items={[
          { key: "campaigns", label: "活动规则" },
          { key: "store-topics", label: "店铺话题规则" },
        ]}
      />

      {activeSection === "campaigns" ? <Card className="surface-card">
        <Table<Campaign>
          rowKey="id"
          loading={loading}
          dataSource={items}
          scroll={{ x: 1150 }}
          columns={[
            {
              title: "活动名称",
              dataIndex: "name",
              width: 300,
              fixed: "left",
              render: (value: string) => <strong>{value}</strong>,
            },
            { title: "月份", dataIndex: "month", width: 100 },
            {
              title: "产品系列",
              width: 280,
              render: (_value, row) =>
                row.products?.length
                  ? row.products.map(({ product }) => product.name).join("、")
                  : row.product?.name || "未关联",
            },
            {
              title: "活动周期",
              width: 220,
              render: (_value, row) =>
                `${dayjs(row.startDate).format("YYYY-MM-DD")} 至 ${dayjs(row.endDate).format("YYYY-MM-DD")}`,
            },
            {
              title: "固定规则",
              width: 220,
              render: (_value, row) =>
                `图文≥${row.minImageCount}张；有效正文≥${row.minBodyLength || 1}字；话题精确且可点击`,
            },
            {
              title: "规则版本",
              width: 120,
              render: (_value, row) => (
                <Space>
                  <span>{row._count.topicRules} 条</span>
                  <Tag>v{row.ruleVersion}</Tag>
                </Space>
              ),
            },
            {
              title: "状态",
              dataIndex: "status",
              width: 90,
              render: (value: string) => <StatusTag value={value} />,
            },
            {
              title: "操作",
              width: 110,
              fixed: "right",
              render: (_value, row) => (
                <Button
                  type="link"
                  icon={<EyeOutlined />}
                  loading={detailLoading}
                  onClick={() => void openDetail(row.id)}
                >
                  查看规则
                </Button>
              ),
            },
          ]}
          pagination={{ pageSize: 10 }}
        />
      </Card> : <StoreTopicRulesPanel canManage={canManageBusiness} />}

      <Modal
        open={importOpen}
        title="导入活动规则"
        width={1100}
        onCancel={() => setImportOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setImportOpen(false)}>
            取消
          </Button>,
          <Button
            key="preview"
            loading={previewing}
            onClick={() => void submitImport(false)}
          >
            预检查
          </Button>,
          <Button
            key="commit"
            type="primary"
            disabled={!preview}
            loading={committing}
            onClick={() => void submitImport(true)}
          >
            确认导入
          </Button>,
        ]}
      >
        <Form form={importForm} layout="vertical" initialValues={defaultMetadata}>
          <Row gutter={12}>
            <Col xs={24} md={9}>
              <Form.Item
                name="campaignName"
                label="活动名称"
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
            </Col>
            <Col xs={12} md={5}>
              <Form.Item name="month" label="活动月份" rules={[{ required: true }]}>
                <Input type="month" />
              </Form.Item>
            </Col>
            <Col xs={12} md={5}>
              <Form.Item
                name="startDate"
                label="开始日期"
                rules={[{ required: true }]}
              >
                <Input type="date" />
              </Form.Item>
            </Col>
            <Col xs={12} md={5}>
              <Form.Item
                name="endDate"
                label="结束日期"
                rules={[{ required: true }]}
              >
                <Input type="date" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
        <Upload.Dragger
          accept=".xlsx,.xls"
          maxCount={1}
          fileList={fileList}
          beforeUpload={() => false}
          onChange={({ fileList: next }) => {
            setFileList(next);
            setPreview(null);
          }}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p>上传原始活动需求表或系统标准模板</p>
          <p className="ant-upload-hint">
            系统会实际读取工作表、单元格、合并区域和嵌入图片位置
          </p>
        </Upload.Dragger>

        {preview ? (
          <>
            <Divider>预检查结果</Divider>
            <Row gutter={[12, 12]}>
              <Col span={4}>
                <Statistic title="活动" value={preview.counts.campaigns} />
              </Col>
              <Col span={4}>
                <Statistic title="产品" value={preview.counts.products} />
              </Col>
              <Col span={4}>
                <Statistic title="话题规则" value={preview.counts.topicRules} />
              </Col>
              <Col span={4}>
                <Statistic
                  title="缺少段位"
                  value={preview.counts.missingStages}
                  valueStyle={{ color: preview.counts.missingStages ? "#cf1322" : undefined }}
                />
              </Col>
              <Col span={4}>
                <Statistic
                  title="不规范话题"
                  value={preview.counts.irregularTopics}
                />
              </Col>
              <Col span={4}>
                <Statistic
                  title="原表产品图位置"
                  value={preview.counts.unrecognizedProductImages}
                />
              </Col>
            </Row>
            <Alert
              showIcon
              type="info"
              style={{ margin: "16px 0 0" }}
              message="客服登记备注（不参与自动审核）"
              description={
                preview.campaign.customerRegistrationNotes ||
                "图片数量由系统自动审核；图片内容要求由客服登记时人工检查"
              }
            />
            <Alert
              showIcon
              type="warning"
              style={{ margin: "16px 0" }}
              message={`将新增：活动 ${preview.changes.create.campaigns} 个、产品 ${preview.changes.create.products.length} 个、话题 ${preview.changes.create.topicRules} 条；将更新：活动 ${preview.changes.update.campaigns} 个、产品 ${preview.changes.update.products.length} 个、话题 ${preview.changes.update.topicRules} 条。`}
              description={`预览结果将按图文笔记最低 ${preview.campaign.minImageCount} 张执行数量审核；原表中的产品图片仅用于识别横向版面和产品行，不参与内容识别。`}
            />
            <Table
              size="small"
              rowKey={(row) => `${row.name}-${row.seriesName}`}
              dataSource={preview.products}
              pagination={false}
              columns={[
                { title: "产品系列", dataIndex: "name", width: 210 },
                {
                  title: "别名",
                  dataIndex: "aliases",
                  width: 220,
                  render: (value: string[]) => value.join("、"),
                },
                { title: "内容参考方向", dataIndex: "contentDirection" },
              ]}
            />
            <Divider orientation="left">异常与自动修正</Divider>
            <List
              size="small"
              bordered
              dataSource={[
                ...preview.diagnostics.unrecognizedCells,
                ...preview.diagnostics.missingProductNames,
                ...preview.diagnostics.missingStages,
                ...preview.diagnostics.duplicateTopics,
                ...preview.diagnostics.irregularTopics,
                ...preview.diagnostics.unrecognizedProductImages,
                ...preview.diagnostics.corrections,
              ]}
              locale={{ emptyText: "未发现异常" }}
              renderItem={(item) => <List.Item>{item}</List.Item>}
            />
          </>
        ) : null}
      </Modal>

      <Drawer
        open={Boolean(detail)}
        width={760}
        title={detail?.name}
        onClose={() => setDetail(null)}
      >
        {detail ? (
          <>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="品牌" span={2}>
                {detail.brandNames?.join("、") ||
                  [
                    detail.product?.brandName,
                    ...detail.products.map(({ product }) => product.brandName),
                  ]
                    .filter(Boolean)
                    .filter((value, index, values) => values.indexOf(value) === index)
                    .join("、") ||
                  "未配置"}
              </Descriptions.Item>
              <Descriptions.Item label="活动周期" span={2}>
                {dayjs(detail.startDate).format("YYYY-MM-DD")} 至{" "}
                {dayjs(detail.endDate).format("YYYY-MM-DD")}
              </Descriptions.Item>
              <Descriptions.Item label="正文要求">
                至少 {detail.minBodyLength} 个有效正文字符
              </Descriptions.Item>
              <Descriptions.Item label="图片数量">
                图文笔记至少 {detail.minImageCount} 张；视频笔记不适用
              </Descriptions.Item>
              <Descriptions.Item label="公开与留存">
                {detail.publicRequired ? "要求公开" : "不要求公开"}；保留{" "}
                {detail.retentionDays} 天
              </Descriptions.Item>
              <Descriptions.Item label="奖励信息" span={2}>
                {detail.rewardDescription || "无"}
              </Descriptions.Item>
              <Descriptions.Item label="客服登记备注" span={2}>
                {detail.customerRegistrationNotes ||
                  "图片数量由系统自动审核；图片内容要求由客服登记时人工检查"}
              </Descriptions.Item>
            </Descriptions>
            <Divider orientation="left">产品与内容参考方向</Divider>
            <List
              bordered
              dataSource={detail.products.map(({ product }) => product)}
              renderItem={(product) => (
                <List.Item>
                  <List.Item.Meta
                    title={product.name}
                    description={
                      <>
                        <div>
                          别名：
                          {product.aliases?.map((alias) => alias.alias).join("、") ||
                            "无"}
                        </div>
                        <div>内容方向：{product.contentDirection || "无"}</div>
                      </>
                    }
                  />
                </List.Item>
              )}
            />
            <Divider orientation="left">话题规则</Divider>
            <Table<TopicRule>
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={detail.topicRules || []}
              columns={[
                {
                  title: "类型",
                  dataIndex: "topicCategory",
                  width: 100,
                  render: (value: string) =>
                    topicCategoryLabels[value] || value,
                },
                {
                  title: "产品/产品阶段话题",
                  width: 260,
                  render: (_value, row) =>
                    [
                      ...new Set(
                        [
                          row.product?.name,
                          row.applicableStage
                            ? productStageTopicLabel(row.applicableStage)
                            : null,
                          row.milkType,
                        ].filter((value): value is string => Boolean(value)),
                      ),
                    ].join(" · ") || "全产品",
                },
                { title: "标准话题", dataIndex: "topic" },
                {
                  title: "校验",
                  width: 130,
                  render: (_value, row) => (
                    <Space size={4}>
                      {row.exactMatch ? <Tag color="blue">精确</Tag> : null}
                      {row.clickableRequired ? (
                        <Tag color="green">可点击</Tag>
                      ) : null}
                      {row.ruleType === "ANY" ? (
                        <Tag color="purple">至少 {row.minCount} 个</Tag>
                      ) : null}
                    </Space>
                  ),
                },
              ]}
            />
          </>
        ) : null}
      </Drawer>
    </>
  );
}
