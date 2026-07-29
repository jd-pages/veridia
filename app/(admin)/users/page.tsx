"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Button, Card, Form, Input, Modal, Select, Table } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import PageHeader from "@/components/PageHeader";
import StatusTag from "@/components/StatusTag";
import { apiFetch } from "@/lib/client";
import { commonStatusLabels } from "@/lib/zh-CN";

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
}

export default function UsersPage() {
  const { message } = App.useApp();
  const [items, setItems] = useState<UserRow[]>([]);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const load = useCallback(async () => {
    try {
      setItems(await apiFetch<UserRow[]>("/api/users"));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "加载用户失败");
    }
  }, [message]);
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <PageHeader
        title="用户管理"
        description="管理员、运营人员与只读人员采用最小权限分工"
        actions={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setOpen(true);
              window.setTimeout(() => {
                form.resetFields();
                form.setFieldsValue({ role: "OPERATOR" });
              }, 0);
            }}
          >
            新增用户
          </Button>
        }
      />
      <Card className="surface-card">
        <Table<UserRow>
          rowKey="id"
          dataSource={items}
          columns={[
            { title: "用户名", dataIndex: "username", width: 180 },
            { title: "显示名称", dataIndex: "displayName", width: 200 },
            { title: "角色", dataIndex: "role", width: 140, render: (value) => <StatusTag value={value} /> },
            { title: "状态", dataIndex: "status", width: 120, render: (value) => <StatusTag value={value} /> },
            {
              title: "最近登录",
              dataIndex: "lastLoginAt",
              render: (value: string | null) => value ? new Date(value).toLocaleString("zh-CN") : "从未登录",
            },
            {
              title: "创建时间",
              dataIndex: "createdAt",
              render: (value: string) => new Date(value).toLocaleString("zh-CN"),
            },
          ]}
        />
      </Card>
      <Modal
        open={open}
        title="新增用户"
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        okText="创建"
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values) => {
            await apiFetch("/api/users", { method: "POST", body: JSON.stringify(values) });
            message.success("用户已创建");
            setOpen(false);
            void load();
          }}
        >
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="displayName" label="显示名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="password" label="初始密码" rules={[{ required: true, min: 8 }]}><Input.Password /></Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select options={[
              { value: "ADMIN", label: commonStatusLabels.ADMIN },
              { value: "OPERATOR", label: commonStatusLabels.OPERATOR },
              { value: "VIEWER", label: commonStatusLabels.VIEWER },
            ]} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
