"use client";

import { useCallback, useEffect, useState } from "react";
import {
  App,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import { apiFetch } from "@/lib/client";
import {
  commercePlatformLabels,
  commercePlatforms,
  type CommercePlatform,
} from "@/lib/result-source";

interface StoreTopicRule {
  id: string;
  commercePlatform: CommercePlatform;
  storeName: string;
  expectedTopic: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface StoreTopicRulePage {
  items: StoreTopicRule[];
  total: number;
  page: number;
  pageSize: number;
}

interface RuleFormValue {
  commercePlatform: CommercePlatform;
  storeName: string;
  enabled: boolean;
}

export default function StoreTopicRulesPanel({ canManage }: { canManage: boolean }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<RuleFormValue>();
  const [items, setItems] = useState<StoreTopicRule[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [platform, setPlatform] = useState<string>("");
  const [status, setStatus] = useState("ALL");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<StoreTopicRule | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        status,
      });
      if (platform) params.set("commercePlatform", platform);
      if (query.trim()) params.set("query", query.trim());
      const data = await apiFetch<StoreTopicRulePage>(
        `/api/store-topic-rules?${params}`,
      );
      setItems(data.items);
      setTotal(data.total);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "加载店铺规则失败");
    } finally {
      setLoading(false);
    }
  }, [message, page, pageSize, platform, query, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({ commercePlatform: "TMALL", storeName: "", enabled: true });
    setModalOpen(true);
  };

  const openEdit = (rule: StoreTopicRule) => {
    setEditing(rule);
    form.setFieldsValue({
      commercePlatform: rule.commercePlatform,
      storeName: rule.storeName,
      enabled: rule.enabled,
    });
    setModalOpen(true);
  };

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await apiFetch(
        editing ? `/api/store-topic-rules/${editing.id}` : "/api/store-topic-rules",
        {
          method: editing ? "PATCH" : "POST",
          body: JSON.stringify(values),
        },
      );
      message.success(editing ? "店铺规则已更新" : "店铺规则已新增");
      setModalOpen(false);
      setPage(1);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "保存店铺规则失败");
    } finally {
      setSaving(false);
    }
  };

  const setEnabled = async (rule: StoreTopicRule, enabled: boolean) => {
    try {
      await apiFetch(`/api/store-topic-rules/${rule.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          commercePlatform: rule.commercePlatform,
          storeName: rule.storeName,
          enabled,
        }),
      });
      message.success(enabled ? "店铺规则已启用" : "店铺规则已停用");
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "更新状态失败");
    }
  };

  const remove = async (rule: StoreTopicRule) => {
    try {
      await apiFetch(`/api/store-topic-rules/${rule.id}`, { method: "DELETE" });
      message.success("店铺规则已删除，历史审核结果已保留");
      if (items.length === 1 && page > 1) setPage(page - 1);
      else await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "删除店铺规则失败");
    }
  };

  return (
    <Card className="surface-card">
      <Space wrap style={{ width: "100%", justifyContent: "space-between", marginBottom: 16 }}>
        <Space wrap>
          <Select
            aria-label="成交平台筛选"
            value={platform}
            style={{ width: 150 }}
            options={[
              { value: "", label: "全部平台" },
              ...commercePlatforms.map((value) => ({
                value,
                label: commercePlatformLabels[value],
              })),
            ]}
            onChange={(value) => { setPlatform(value); setPage(1); }}
          />
          <Select
            aria-label="店铺规则状态筛选"
            value={status}
            style={{ width: 130 }}
            options={[
              { value: "ALL", label: "全部状态" },
              { value: "ENABLED", label: "已启用" },
              { value: "DISABLED", label: "已停用" },
            ]}
            onChange={(value) => { setStatus(value); setPage(1); }}
          />
          <Input.Search
            aria-label="搜索店铺名称"
            allowClear
            placeholder="搜索店铺名称"
            style={{ width: 260 }}
            onSearch={(value) => { setQuery(value); setPage(1); }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
        </Space>
        <Space>
          <Typography.Text type="secondary">共 {total} 条配置</Typography.Text>
          {canManage ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增店铺
            </Button>
          ) : null}
        </Space>
      </Space>

      <Table<StoreTopicRule>
        rowKey="id"
        loading={loading}
        dataSource={items}
        scroll={{ x: 880 }}
        columns={[
          {
            title: "成交平台",
            dataIndex: "commercePlatform",
            width: 110,
            render: (value: CommercePlatform) => commercePlatformLabels[value],
          },
          { title: "标准店铺名称", dataIndex: "storeName", width: 230 },
          { title: "要求店铺话题", dataIndex: "expectedTopic", width: 250 },
          {
            title: "状态",
            dataIndex: "enabled",
            width: 100,
            render: (enabled: boolean) => (
              <Tag color={enabled ? "green" : "default"}>{enabled ? "已启用" : "已停用"}</Tag>
            ),
          },
          {
            title: "创建时间",
            dataIndex: "createdAt",
            width: 165,
            render: (value: string) => dayjs(value).format("YYYY-MM-DD HH:mm"),
          },
          {
            title: "更新时间",
            dataIndex: "updatedAt",
            width: 165,
            render: (value: string) => dayjs(value).format("YYYY-MM-DD HH:mm"),
          },
          {
            title: "操作",
            width: 220,
            fixed: "right",
            render: (_value, rule) => canManage ? (
              <Space size={4}>
                <Button type="link" icon={<EditOutlined />} onClick={() => openEdit(rule)}>
                  编辑
                </Button>
                <Switch
                  size="small"
                  checked={rule.enabled}
                  checkedChildren="启用"
                  unCheckedChildren="停用"
                  onChange={(value) => void setEnabled(rule, value)}
                />
                <Popconfirm
                  title="删除店铺规则？"
                  description="删除后，该店铺规则将不再参与后续导入和审核。历史审核结果不会被删除。"
                  okText="确认删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void remove(rule)}
                >
                  <Button danger type="link" icon={<DeleteOutlined />}>删除</Button>
                </Popconfirm>
              </Space>
            ) : "—",
          },
        ]}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (value) => `共 ${value} 条`,
          onChange: (nextPage, nextPageSize) => {
            setPage(nextPageSize === pageSize ? nextPage : 1);
            setPageSize(nextPageSize);
          },
        }}
      />

      <Modal
        open={modalOpen}
        title={editing ? "编辑店铺规则" : "新增店铺"}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void save()}
        onCancel={() => setModalOpen(false)}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="commercePlatform" label="成交平台" rules={[{ required: true, message: "请选择成交平台" }]}>
            <Select options={commercePlatforms.map((value) => ({ value, label: commercePlatformLabels[value] }))} />
          </Form.Item>
          <Form.Item name="storeName" label="标准店铺名称" rules={[{ required: true, whitespace: true, message: "请输入标准店铺名称" }]}>
            <Input placeholder="请输入完整店铺名称" />
          </Form.Item>
          <Form.Item label="要求店铺话题" shouldUpdate>
            {() => {
              const storeName = String(form.getFieldValue("storeName") || "").trim();
              return <Input value={storeName ? `#${storeName}` : ""} disabled />;
            }}
          </Form.Item>
          <Form.Item name="enabled" label="状态" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
