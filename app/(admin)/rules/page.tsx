"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  App,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Row,
  Typography,
} from "antd";
import {
  ArrowLeftOutlined,
  EditOutlined,
  PlusOutlined,
  RightOutlined,
  StopOutlined,
} from "@ant-design/icons";
import PageHeader from "@/components/PageHeader";
import StatusTag from "@/components/StatusTag";
import { apiFetch } from "@/lib/client";
import { ruleScopeLabels, ruleTypeLabels } from "@/lib/zh-CN";
import type { SessionUser } from "@/lib/auth";
import { canAccessBusiness } from "@/lib/permissions";
import {
  aggregateProductStageTopicRows,
  aggregateDetailedProductStageTopicRows,
  campaignUsesDetailedProductStages,
  productStageTopicLabel,
} from "@/lib/product-stage";
import { rulesRequireAnyProductStage } from "@/lib/campaign-stage-requirement";

interface Product {
  id: string;
  name: string;
  code: string;
  brandName: string;
}

interface Campaign {
  id: string;
  name: string;
  productId: string;
  month: string;
  product: Product;
  products?: Array<{ product: Product }>;
  ruleVersion?: number;
  status?: string;
}

interface Rule {
  id: string;
  brandName: string | null;
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
  topicCategory: string;
  applicableStage: string | null;
  campaign: Campaign | null;
  product: Product | null;
}

interface RuleBrand {
  brandName: string;
  productCount: number;
  campaignCount: number;
  ruleCount: number;
  productNames: string[];
  status: string;
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

interface StageDisplayRow {
  key: string;
  label?: string;
  requiredTopics: string[];
  ruleSources: string[];
  members: StageGroup[];
}

function monthLabel(value: string) {
  const [year, month] = value.split("-");
  return `${year}年${Number(month)}月`;
}

function updateRulePageUrl(brandName?: string, month?: string) {
  const url = new URL(window.location.href);
  if (brandName) url.searchParams.set("brand", brandName);
  else url.searchParams.delete("brand");
  if (month) url.searchParams.set("month", month);
  else url.searchParams.delete("month");
  window.history.replaceState(window.history.state, "", url);
}

export default function RulesPage() {
  const { message } = App.useApp();
  const [brands, setBrands] = useState<RuleBrand[]>([]);
  const [selectedBrand, setSelectedBrand] = useState<string>();
  const [selectedMonth, setSelectedMonth] = useState<string>();
  const [rules, setRules] = useState<Rule[]>([]);
  const [stageGroups, setStageGroups] = useState<StageGroup[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [brandCampaigns, setBrandCampaigns] = useState<Campaign[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [campaignId, setCampaignId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [monthOpen, setMonthOpen] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [editingStage, setEditingStage] = useState<StageGroup | null>(null);
  const [currentRole, setCurrentRole] = useState<SessionUser["role"] | null>(
    null,
  );
  const [form] = Form.useForm();
  const [stageForm] = Form.useForm();
  const [monthForm] = Form.useForm();
  const copyExistingMonth = Form.useWatch("copyExisting", monthForm);
  const scope = Form.useWatch("scope", form);
  const canManageBusiness = canAccessBusiness(currentRole);
  const showProductStageModule = useMemo(
    () => rulesRequireAnyProductStage(rules),
    [rules],
  );
  const displayedRules = useMemo(
    () =>
      showProductStageModule
        ? rules
        : rules.filter((rule) => rule.topicCategory !== "PRODUCT_STAGE"),
    [rules, showProductStageModule],
  );
  const displayedStageGroups = useMemo(
    () => {
      const source =
        stageGroups.map((group) => ({
          ...group,
          requiredTopic:
            rules.find(
              (rule) =>
                rule.topicCategory === "PRODUCT_STAGE" &&
                rule.applicableStage === group.key,
            )?.topic || "未配置",
        }));
      return campaignUsesDetailedProductStages(selectedBrand, selectedMonth)
        ? aggregateDetailedProductStageTopicRows(source)
        : aggregateProductStageTopicRows(source);
    },
    [rules, selectedBrand, selectedMonth, stageGroups],
  );

  const loadBrands = useCallback(async () => {
    setLoading(true);
    try {
      setBrands(await apiFetch<RuleBrand[]>("/api/rule-brands"));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "加载品牌失败");
    } finally {
      setLoading(false);
    }
  }, [message]);

  const load = useCallback(async (options?: { brand?: string; month?: string }) => {
    const activeBrand = options?.brand || selectedBrand;
    if (!activeBrand) return;
    setLoading(true);
    try {
      const [campaignData, productData, stageData] = await Promise.all([
        apiFetch<Campaign[]>("/api/campaigns"),
        apiFetch<Product[]>("/api/products"),
        apiFetch<StageGroup[]>("/api/rule-stage-groups"),
      ]);
      const matchingCampaigns = campaignData.filter((campaign) =>
        [
          campaign.product?.brandName,
          ...(campaign.products || []).map(({ product }) => product.brandName),
        ].includes(activeBrand),
      );
      const requestedMonth = options?.month || selectedMonth ||
        new URLSearchParams(window.location.search).get("month") ||
        matchingCampaigns[0]?.month;
      const monthlyCampaigns = matchingCampaigns.filter(
        (campaign) => campaign.month === requestedMonth,
      );
      const ruleData = requestedMonth
        ? await apiFetch<Rule[]>(
            `/api/rules?brandName=${encodeURIComponent(activeBrand)}&month=${encodeURIComponent(requestedMonth)}`,
          )
        : [];
      setRules(ruleData);
      setBrandCampaigns(matchingCampaigns);
      setCampaigns(monthlyCampaigns);
      if (requestedMonth && requestedMonth !== selectedMonth) {
        setSelectedMonth(requestedMonth);
        updateRulePageUrl(activeBrand, requestedMonth);
      }
      if (campaignId && !monthlyCampaigns.some((item) => item.id === campaignId)) {
        setCampaignId(undefined);
      }
      setProducts(
        productData.filter((product) => product.brandName === activeBrand),
      );
      setStageGroups(stageData);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "加载规则失败");
    } finally {
      setLoading(false);
    }
  }, [campaignId, message, selectedBrand, selectedMonth]);

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    setSelectedBrand(search.get("brand") || undefined);
    setSelectedMonth(search.get("month") || undefined);
    void loadBrands();
    void apiFetch<SessionUser | null>("/api/auth/me").then((user) =>
      setCurrentRole(user?.role || null),
    );
  }, [loadBrands]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!selectedBrand) {
    return (
      <>
        <PageHeader
          title="话题规则"
          description="按品牌维护产品话题与阶段话题，审核任务将根据产品品牌自动匹配对应规则。"
        />
        <Row className="rule-brand-grid" gutter={[16, 16]}>
          {brands.map((brand) => (
            <Col key={brand.brandName} xs={24} md={12}>
              <Card
                className="surface-card rule-brand-card"
                loading={loading}
                title={brand.brandName}
                extra={<StatusTag value={brand.status} />}
                actions={[
                  <Button
                    key="enter"
                    type="link"
                    icon={<RightOutlined />}
                    onClick={() => {
                      setSelectedBrand(brand.brandName);
                      setSelectedMonth(undefined);
                      updateRulePageUrl(brand.brandName);
                    }}
                  >
                    进入规则
                  </Button>,
                ]}
              >
                <Row gutter={12}>
                  <Col span={8}>
                    <Statistic title="产品" value={brand.productCount} suffix="个" />
                  </Col>
                  <Col span={8}>
                    <Statistic title="活动" value={brand.campaignCount} suffix="个" />
                  </Col>
                  <Col span={8}>
                    <Statistic title="规则" value={brand.ruleCount} suffix="条" />
                  </Col>
                </Row>
                <Typography.Paragraph
                  className="rule-brand-products"
                  type="secondary"
                >
                  包含产品：{brand.productNames.join("、") || "暂无产品"}
                </Typography.Paragraph>
              </Card>
            </Col>
          ))}
        </Row>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={`${selectedBrand}话题规则`}
        breadcrumbItems={[
          "话题规则",
          selectedBrand,
          ...(selectedMonth ? [monthLabel(selectedMonth)] : []),
        ]}
        description={
          showProductStageModule
            ? "产品阶段仅用于匹配对应话题，不要求正文出现段位词。标准话题会自动去空格并统一补充 #"
            : "标准话题会自动去空格并统一补充 #"
        }
        actions={(
          <Space wrap>
            <Button
              icon={<ArrowLeftOutlined />}
              onClick={() => {
                setSelectedBrand(undefined);
                setSelectedMonth(undefined);
                setCampaignId(undefined);
                updateRulePageUrl();
                void loadBrands();
              }}
            >
              返回品牌列表
            </Button>
            {canManageBusiness ? (
              <Button
                icon={<PlusOutlined />}
                onClick={() => {
                  setMonthOpen(true);
                  window.setTimeout(() => {
                    monthForm.resetFields();
                    monthForm.setFieldsValue({
                      copyExisting: true,
                      sourceCampaignId:
                        campaigns[0]?.id || brandCampaigns[0]?.id,
                    });
                  });
                }}
              >
                新增月份规则
              </Button>
            ) : null}
            {canManageBusiness && campaigns.length ? (
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
            ) : null}
          </Space>
        )}
      />
      <Card className="surface-card" style={{ marginBottom: 16 }}>
        <Space wrap size="large">
          <Typography.Text strong>规则月份</Typography.Text>
          <Select
            value={selectedMonth}
            placeholder="选择规则月份"
            style={{ width: 180 }}
            onChange={(month) => {
              setLoading(true);
              setCampaignId(undefined);
              setSelectedMonth(month);
              updateRulePageUrl(selectedBrand, month);
            }}
            options={[
              ...new Set([
                ...brandCampaigns.map((campaign) => campaign.month),
                ...(selectedMonth ? [selectedMonth] : []),
              ]),
            ].sort().reverse().map((month) => ({
              value: month,
              label: monthLabel(month),
            }))}
          />
          <Statistic title="产品" value={[
            ...new Set(campaigns.flatMap((campaign) => [
              campaign.product?.id,
              ...(campaign.products || []).map(({ product }) => product.id),
            ]).filter(Boolean)),
          ].length} suffix="个" />
          <Statistic title="活动" value={campaigns.length} suffix="个" />
          <Statistic title="规则" value={rules.length} suffix="条" />
          <Statistic title="规则版本" value={campaigns[0]?.ruleVersion || 0} prefix="v" />
          <StatusTag value={campaigns[0]?.status || "INACTIVE"} />
        </Space>
      </Card>
      {!campaigns.length ? (
        <Card className="surface-card" style={{ marginBottom: 16, textAlign: "center" }}>
          <Typography.Title level={4}>当前月份暂无规则</Typography.Title>
          <Typography.Paragraph type="secondary">
            可通过“新增月份规则”创建空白规则集，或复制已有月份规则。
          </Typography.Paragraph>
        </Card>
      ) : null}
      {showProductStageModule ? (
        <Card
          className="surface-card"
          title="产品阶段与要求话题"
          style={{ marginBottom: 16 }}
        >
          <Table<StageDisplayRow>
            rowKey="key"
            dataSource={displayedStageGroups}
            pagination={false}
            columns={[
            {
              title: "产品阶段话题",
              width: 180,
              render: (_value, row) => row.label || productStageTopicLabel(row.key),
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
      ) : null}
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
          dataSource={displayedRules}
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
                        await apiFetch(
                          `/api/rules/${row.id}?brandName=${encodeURIComponent(selectedBrand)}`,
                          { method: "DELETE" },
                        );
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
        open={monthOpen}
        title="新增月份规则"
        okText="创建"
        onCancel={() => setMonthOpen(false)}
        onOk={() => monthForm.submit()}
      >
        <Form
          form={monthForm}
          layout="vertical"
          onFinish={async (values: {
            month: string;
            copyExisting?: boolean;
            sourceCampaignId?: string;
          }) => {
            if (values.copyExisting) {
              if (!values.sourceCampaignId) {
                message.error("请选择复制来源月份");
                return;
              }
              await apiFetch(`/api/campaigns/${values.sourceCampaignId}/copy`, {
                method: "POST",
                body: JSON.stringify({ month: values.month }),
              });
            } else {
              const namePrefix = selectedBrand === "达能" ? "爱他美" : selectedBrand;
              await apiFetch("/api/campaigns", {
                method: "POST",
                body: JSON.stringify({
                  name: `${namePrefix}${monthLabel(values.month)}小红书种草审核`,
                  month: values.month,
                  productIds: products.map((product) => product.id),
                }),
              });
            }
            message.success(`${monthLabel(values.month)}规则已独立创建`);
            setMonthOpen(false);
            setCampaignId(undefined);
            setSelectedMonth(values.month);
            updateRulePageUrl(selectedBrand, values.month);
            await load({ brand: selectedBrand, month: values.month });
          }}
        >
          <Form.Item
            name="month"
            label="规则月份"
            rules={[
              { required: true, message: "请选择规则月份" },
              { pattern: /^\d{4}-\d{2}$/u, message: "月份格式应为 YYYY-MM" },
            ]}
          >
            <Input type="month" />
          </Form.Item>
          <Form.Item
            name="copyExisting"
            label="复制已有月份规则"
            valuePropName="checked"
          >
            <Switch checkedChildren="复制" unCheckedChildren="空白" />
          </Form.Item>
          {copyExistingMonth ? (
            <Form.Item
              name="sourceCampaignId"
              label="复制来源月份"
              rules={[{ required: true }]}
              extra="复制会创建新的活动和规则 ID；修改新月份不会影响来源月份。"
            >
              <Select
                options={brandCampaigns.map((campaign) => ({
                  value: campaign.id,
                  label: `${monthLabel(campaign.month)} · ${campaign.name}`,
                }))}
              />
            </Form.Item>
          ) : null}
        </Form>
      </Modal>
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
              body: JSON.stringify({ ...values, brandName: selectedBrand }),
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
                brandName: selectedBrand,
                campaignId: campaigns[0]?.id,
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
