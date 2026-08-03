"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from "antd";
import { EditOutlined, PlusOutlined, StopOutlined } from "@ant-design/icons";
import PageHeader from "@/components/PageHeader";
import StatusTag from "@/components/StatusTag";
import { apiFetch } from "@/lib/client";
import { ruleScopeLabels, ruleTypeLabels } from "@/lib/zh-CN";
import type { SessionUser } from "@/lib/auth";
import { canAccessBusiness } from "@/lib/permissions";
import {
  aggregateProductStageTopicRows,
  productStageTopicLabel,
  type ProductStageTopicDisplayRow,
} from "@/lib/product-stage";

interface Product {
  id: string;
  name: string;
  code: string;
}

interface Campaign {
  id: string;
  name: string;
  productId: string;
  month: string;
  product: Product;
}

interface Rule {
  id: string;
  scope: string;
  campaignId: string | null;
  productId: string | null;
  ruleType: string;
  topic: string;
  exactMatch: boolean;
  clickableRequired: boolean;
  caseSensitive: boolean;
  minCount: number;
  sortOrder: number;
  version: number;
  status: string;
  notes: string | null;
  campaign: Campaign | null;
  product: Product | null;
}

interface StageGroup {
  key: string;
  label: string;
  canonicalStages: string[];
  bodyTerms: string[];
  requireBodyStage: boolean;
  requiredTopic: string;
  ruleSource: string;
}

export default function RulesPage() {
  const { message } = App.useApp();
  const [rules, setRules] = useState<Rule[]>([]);
  const [stageGroups, setStageGroups] = useState<StageGroup[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [campaignId, setCampaignId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [editingStage, setEditingStage] = useState<StageGroup | null>(null);
  const [currentRole, setCurrentRole] = useState<SessionUser["role"] | null>(
    null,
  );
  const [form] = Form.useForm();
  const [stageForm] = Form.useForm();
  const scope = Form.useWatch("scope", form);
  const canManageBusiness = canAccessBusiness(currentRole);
  const displayedStageGroups = useMemo(
    () => aggregateProductStageTopicRows(stageGroups),
    [stageGroups],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ruleData, campaignData, productData, stageData] = await Promise.all([
        apiFetch<Rule[]>(
          `/api/rules${campaignId ? `?campaignId=${campaignId}` : ""}`,
        ),
        apiFetch<Campaign[]>("/api/campaigns"),
        apiFetch<Product[]>("/api/products"),
        apiFetch<StageGroup[]>("/api/rule-stage-groups"),
      ]);
      setRules(ruleData);
      setCampaigns(campaignData);
      setProducts(productData);
      setStageGroups(stageData);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "加载规则失败");
    } finally {
      setLoading(false);
    }
  }, [campaignId, message]);

  useEffect(() => {
    void load();
    void apiFetch<SessionUser | null>("/api/auth/me").then((user) =>
      setCurrentRole(user?.role || null),
    );
  }, [load]);

  return (
    <>
      <PageHeader
        title="话题规则"
        description="产品阶段仅用于匹配对应话题，不要求正文出现段位词。标准话题会自动去空格并统一补充 #"
        actions={canManageBusiness ? (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              setOpen(true);
              window.setTimeout(() => {
                form.resetFields();
                form.setFieldsValue({
                  scope: "CAMPAIGN",
                  ruleType: "MUST_ALL",
                  exactMatch: true,
                  clickableRequired: true,
                  caseSensitive: false,
                  minCount: 1,
                  sortOrder: 10,
                });
              }, 0);
            }}
          >
            新增规则
          </Button>
        ) : undefined}
      />
      <Card
        className="surface-card"
        title="产品阶段与要求话题"
        style={{ marginBottom: 16 }}
      >
        <Table<ProductStageTopicDisplayRow<StageGroup>>
          rowKey="key"
          dataSource={displayedStageGroups}
          pagination={false}
          columns={[
            {
              title: "产品阶段话题",
              width: 180,
              render: (_value, row) => productStageTopicLabel(row.key),
            },
            {
              title: "要求阶段话题",
              dataIndex: "requiredTopics",
              render: (value: string[]) => value.join(" / "),
            },
            {
              title: "规则来源",
              dataIndex: "ruleSources",
              width: 120,
              render: (values: string[]) => [
                ...new Set(
                  values.map((value) =>
                    value === "LOCAL_DRAFT" ? "本地草稿" : "已发布规则",
                  ),
                ),
              ].join(" / "),
            },
            {
              title: "操作",
              width: 280,
              render: (_value, row) => canManageBusiness ? (
                <Space size={4} wrap>
                  {row.members.map((member) => (
                    <Button
                      key={member.key}
                      type="link"
                      icon={<EditOutlined />}
                      onClick={() => {
                        setEditingStage(member);
                        stageForm.setFieldsValue({
                          requireBodyStage: member.requireBodyStage,
                          requiredTopic: member.requiredTopic,
                        });
                      }}
                    >
                      编辑 {member.requiredTopic}
                    </Button>
                  ))}
                </Space>
              ) : <Tag>只读</Tag>,
            },
          ]}
        />
      </Card>
      <Card className="surface-card">
        <div className="filter-bar">
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            value={campaignId}
            onChange={setCampaignId}
            placeholder="按活动筛选"
            style={{ width: 340 }}
            options={campaigns.map((item) => ({
              value: item.id,
              label: `${item.month} · ${item.name}`,
            }))}
          />
          <Button onClick={() => void load()}>查询</Button>
        </div>
        <Table<Rule>
          rowKey="id"
          loading={loading}
          dataSource={rules}
          scroll={{ x: 1300 }}
          columns={[
            {
              title: "标准话题词",
              dataIndex: "topic",
              fixed: "left",
              width: 210,
              render: (value: string) => (
                <Tag color="blue" style={{ fontSize: 14 }}>
                  {value}
                </Tag>
              ),
            },
            {
              title: "规则层级",
              dataIndex: "scope",
              width: 110,
              render: (value: string) => ruleScopeLabels[value] || value,
            },
            {
              title: "规则类型",
              dataIndex: "ruleType",
              width: 150,
              render: (value: string) => ruleTypeLabels[value] || value,
            },
            {
              title: "所属活动",
              width: 260,
              render: (_value, row) => row.campaign?.name || "-",
            },
            {
              title: "所属产品",
              width: 200,
              render: (_value, row) =>
                row.product?.name || row.campaign?.product?.name || "-",
            },
            {
              title: "匹配设置",
              width: 260,
              render: (_value, row) => (
                <Space wrap size={4}>
                  {row.exactMatch ? <Tag>精确匹配</Tag> : null}
                  {row.clickableRequired ? <Tag color="blue">要求可点击</Tag> : null}
                  {row.caseSensitive ? <Tag>区分大小写</Tag> : null}
                  {row.ruleType === "ANY" ? <Tag>至少 {row.minCount} 个</Tag> : null}
                </Space>
              ),
            },
            { title: "排序", dataIndex: "sortOrder", width: 80 },
            {
              title: "版本",
              dataIndex: "version",
              width: 80,
              render: (value: number) => `v${value}`,
            },
            {
              title: "状态",
              dataIndex: "status",
              width: 90,
              render: (value: string) => <StatusTag value={value} />,
            },
            {
              title: "操作",
              width: 150,
              fixed: "right",
              render: (_value, row) => canManageBusiness ? (
                <Space size={2}>
                  <Button
                    type="link"
                    icon={<EditOutlined />}
                    onClick={() => {
                      setEditing(row);
                      setOpen(true);
                      window.setTimeout(() => {
                        form.resetFields();
                        form.setFieldsValue(row);
                      }, 0);
                    }}
                  >
                    编辑
                  </Button>
                  {row.status === "ACTIVE" ? (
                    <Popconfirm
                      title="确认停用规则？"
                      description="活动规则版本会自动递增，历史审核结果不受影响。"
                      onConfirm={async () => {
                        await apiFetch(`/api/rules/${row.id}`, { method: "DELETE" });
                        message.success("规则已停用");
                        void load();
                      }}
                    >
                      <Button type="link" danger icon={<StopOutlined />}>
                        停用
                      </Button>
                    </Popconfirm>
                  ) : null}
                </Space>
              ) : <Tag>只读</Tag>,
            },
          ]}
          pagination={{ pageSize: 12 }}
        />
      </Card>
      <Modal
        open={open}
        title={editing ? "编辑话题规则" : "新增话题规则"}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        okText="保存"
        width={680}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values) => {
            await apiFetch(editing ? `/api/rules/${editing.id}` : "/api/rules", {
              method: editing ? "PUT" : "POST",
              body: JSON.stringify(values),
            });
            message.success(editing ? "规则已更新并生成新版本" : "规则已创建");
            setOpen(false);
            void load();
          }}
        >
          <Space style={{ display: "flex" }} align="start">
            <Form.Item name="scope" label="规则层级" rules={[{ required: true }]}>
              <Select
                disabled={Boolean(editing)}
                style={{ width: 180 }}
                options={[
                  {
                    value: "GLOBAL",
                    label: `${ruleScopeLabels.GLOBAL}规则`,
                  },
                  {
                    value: "PRODUCT",
                    label: `${ruleScopeLabels.PRODUCT}规则`,
                  },
                  {
                    value: "CAMPAIGN",
                    label: `${ruleScopeLabels.CAMPAIGN}规则`,
                  },
                ]}
              />
            </Form.Item>
            <Form.Item name="ruleType" label="规则类型" rules={[{ required: true }]}>
              <Select
                style={{ width: 220 }}
                options={Object.entries(ruleTypeLabels).map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
            </Form.Item>
          </Space>
          {scope === "CAMPAIGN" ? (
            <Form.Item name="campaignId" label="所属活动" rules={[{ required: true }]}>
              <Select
                showSearch
                optionFilterProp="label"
                disabled={Boolean(editing)}
                onChange={(value) => {
                  const campaign = campaigns.find((item) => item.id === value);
                  form.setFieldValue("productId", campaign?.productId);
                }}
                options={campaigns.map((item) => ({
                  value: item.id,
                  label: `${item.month} · ${item.name}`,
                }))}
              />
            </Form.Item>
          ) : null}
          {scope === "PRODUCT" ? (
            <Form.Item name="productId" label="所属产品" rules={[{ required: true }]}>
              <Select
                disabled={Boolean(editing)}
                options={products.map((item) => ({
                  value: item.id,
                  label: `${item.code} · ${item.name}`,
                }))}
              />
            </Form.Item>
          ) : (
            <Form.Item name="productId" hidden><Input /></Form.Item>
          )}
          <Form.Item
            name="topic"
            label="标准话题词"
            rules={[{ required: true }]}
            extra="可以不输入 #，保存时自动规范化"
          >
            <Input placeholder="例如 inne多维锌" />
          </Form.Item>
          <Space size={28} wrap>
            <Form.Item name="exactMatch" label="精确匹配" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item
              name="clickableRequired"
              label="要求蓝色可点击"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name="caseSensitive"
              label="区分大小写"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          </Space>
          <Space align="start">
            <Form.Item name="minCount" label="最少出现数量">
              <InputNumber min={1} max={50} />
            </Form.Item>
            <Form.Item name="sortOrder" label="排序">
              <InputNumber min={0} max={9999} />
            </Form.Item>
          </Space>
          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        open={Boolean(editingStage)}
        title={`编辑 ${
          editingStage
            ? productStageTopicLabel(editingStage.key)
            : "产品阶段话题"
        }`}
        okText="保存为本地草稿"
        onCancel={() => setEditingStage(null)}
        onOk={() => stageForm.submit()}
      >
        <Form
          form={stageForm}
          layout="vertical"
          onFinish={async (values) => {
            if (!editingStage) return;
            await apiFetch(`/api/rule-stage-groups/${editingStage.key}`, {
              method: "PUT",
              body: JSON.stringify({
                bodyTerms: editingStage.bodyTerms,
                requireBodyStage: Boolean(values.requireBodyStage),
                requiredTopic: values.requiredTopic,
              }),
            });
            message.success("产品阶段话题已保存为本地草稿");
            setEditingStage(null);
            void load();
          }}
        >
          <Form.Item
            name="requireBodyStage"
            label="是否校验正文段位"
            valuePropName="checked"
            extra="当前业务规则关闭此项；产品阶段仅用于匹配对应的蓝色可点击话题。"
          >
            <Switch checkedChildren="校验" unCheckedChildren="不校验" />
          </Form.Item>
          <Form.Item
            name="requiredTopic"
            label="要求阶段话题"
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
