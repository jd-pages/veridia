"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  App,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Upload,
} from "antd";
import {
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
  SearchOutlined,
  StopOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import type { UploadProps } from "antd";
import PageHeader from "@/components/PageHeader";
import StatusTag from "@/components/StatusTag";
import { apiFetch } from "@/lib/client";

interface Product {
  id: string;
  code: string | null;
  name: string;
  brandName: string;
  seriesName: string | null;
  category: string | null;
  contentDirection: string | null;
  status: string;
  aliases: Array<{ id: string; alias: string }>;
  _count?: { campaigns: number };
  createdAt: string;
  updatedAt: string;
}

export default function ProductsPage() {
  const { message } = App.useApp();
  const [items, setItems] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [form] = Form.useForm();
  const importRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(
        await apiFetch<Product[]>(
          `/api/products${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ""}`,
        ),
      );
    } catch (error) {
      message.error(error instanceof Error ? error.message : "加载产品失败");
    } finally {
      setLoading(false);
    }
  }, [keyword, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const uploadProps: UploadProps = {
    accept: ".xlsx",
    showUploadList: false,
    customRequest: async ({ file, onSuccess, onError }) => {
      const data = new FormData();
      data.append("file", file as File);
      try {
        await apiFetch("/api/products/excel", { method: "POST", body: data });
        message.success("产品 Excel 已导入");
        onSuccess?.({});
        void load();
      } catch (error) {
        message.error(error instanceof Error ? error.message : "导入失败");
        onError?.(error as Error);
      }
    },
  };

  return (
    <>
      <PageHeader
        title="产品管理"
        description="产品主数据、品牌信息与运营常用别名统一维护"
        actions={
          <Space>
            <Upload {...uploadProps}>
              <Button icon={<UploadOutlined />}>Excel 导入</Button>
            </Upload>
            <Button
              icon={<DownloadOutlined />}
              onClick={() => window.open("/api/products/excel", "_blank")}
            >
              导出
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditing(null);
                setOpen(true);
                window.setTimeout(() => form.resetFields(), 0);
              }}
            >
              新增产品
            </Button>
          </Space>
        }
      />
      <Card className="surface-card">
        <div className="filter-bar">
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onPressEnter={() => void load()}
            prefix={<SearchOutlined />}
            placeholder="搜索编码、名称、品牌或别名"
            style={{ width: 320 }}
            allowClear
          />
          <Button onClick={() => void load()}>查询</Button>
        </div>
        <Table<Product>
          rowKey="id"
          loading={loading}
          dataSource={items}
          scroll={{ x: 1080 }}
          columns={[
            { title: "产品编码", dataIndex: "code", width: 150, fixed: "left" },
            {
              title: "产品名称",
              dataIndex: "name",
              width: 220,
              fixed: "left",
              render: (value: string) => <strong>{value}</strong>,
            },
            { title: "品牌名称", dataIndex: "brandName", width: 140 },
            { title: "产品分类", dataIndex: "category", width: 140 },
            {
              title: "产品别名",
              dataIndex: "aliases",
              width: 260,
              render: (aliases: Product["aliases"]) =>
                aliases.length
                  ? aliases.map((item) => <Tag key={item.id}>{item.alias}</Tag>)
                  : "-",
            },
            {
              title: "活动数",
              width: 90,
              render: (_value, row) => row._count?.campaigns || 0,
            },
            {
              title: "状态",
              dataIndex: "status",
              width: 90,
              render: (value: string) => <StatusTag value={value} />,
            },
            {
              title: "更新时间",
              dataIndex: "updatedAt",
              width: 170,
              render: (value: string) => new Date(value).toLocaleString("zh-CN"),
            },
            {
              title: "操作",
              key: "actions",
              fixed: "right",
              width: 150,
              render: (_value, row) => (
                <Space size={4}>
                  <Button
                    type="link"
                    icon={<EditOutlined />}
                    onClick={() => {
                      setEditing(row);
                      setOpen(true);
                      window.setTimeout(() => {
                        form.resetFields();
                        form.setFieldsValue({
                          ...row,
                          aliases: row.aliases.map((item) => item.alias).join("；"),
                        });
                      }, 0);
                    }}
                  >
                    编辑
                  </Button>
                  {row.status === "ACTIVE" ? (
                    <Popconfirm
                      title="确认停用该产品？"
                      description="已产生的历史审核结果不会被删除。"
                      onConfirm={async () => {
                        await apiFetch(`/api/products/${row.id}`, { method: "DELETE" });
                        message.success("产品已停用");
                        void load();
                      }}
                    >
                      <Button type="link" danger icon={<StopOutlined />}>
                        停用
                      </Button>
                    </Popconfirm>
                  ) : null}
                </Space>
              ),
            },
          ]}
          pagination={{ pageSize: 10, showSizeChanger: true }}
        />
      </Card>
      <input ref={importRef} type="file" hidden />
      <Modal
        title={editing ? "编辑产品" : "新增产品"}
        open={open}
        onCancel={() => setOpen(false)}
        okText="保存"
        cancelText="取消"
        onOk={() => form.submit()}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values: {
            code?: string;
            name: string;
            brandName: string;
            seriesName?: string;
            category?: string;
            contentDirection?: string;
            aliases?: string;
          }) => {
            const payload = {
              ...values,
              aliases: values.aliases
                ?.split(/[；;\n]/)
                .map((item) => item.trim())
                .filter(Boolean),
            };
            await apiFetch(editing ? `/api/products/${editing.id}` : "/api/products", {
              method: editing ? "PUT" : "POST",
              body: JSON.stringify(payload),
            });
            message.success(editing ? "产品已更新" : "产品已创建");
            setOpen(false);
            void load();
          }}
        >
          <Form.Item
            name="code"
            label="产品编码"
            extra="没有正式商品编码时可留空，系统会使用内部 ID"
          >
            <Input placeholder="可选，例如 INNE-ZINC" />
          </Form.Item>
          <Form.Item name="name" label="产品名称" rules={[{ required: true }]}>
            <Input placeholder="产品标准名称" />
          </Form.Item>
          <Form.Item name="brandName" label="品牌名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="seriesName" label="产品系列">
            <Input placeholder="默认与产品名称相同" />
          </Form.Item>
          <Form.Item name="category" label="产品分类">
            <Input />
          </Form.Item>
          <Form.Item name="aliases" label="产品别名" extra="多个别名用中文分号分隔">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item
            name="contentDirection"
            label="内容参考方向"
            extra="仅作创作提示和人工复核依据，不作为必含关键词"
          >
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
