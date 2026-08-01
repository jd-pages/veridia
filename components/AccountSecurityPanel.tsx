"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
} from "antd";
import type { SessionUser } from "@/lib/auth";
import { apiFetch } from "@/lib/client";

interface ManagedAccount {
  id: string;
  accountId: string;
  username: string;
  displayName: string;
  role: SessionUser["role"];
  status: "ACTIVE" | "DISABLED" | "EXPIRED";
  issuedAt: string | null;
  expiresAt: string | null;
  activatedAt: string | null;
  lastLocalLoginAt: string | null;
}

const roleLabels = {
  ADMIN: "管理员",
  OPERATOR: "审核员",
  VIEWER: "只读人员",
};

const statusLabels = {
  ACTIVE: { label: "正常", color: "success" },
  DISABLED: { label: "已停用", color: "error" },
  EXPIRED: { label: "已到期", color: "warning" },
};

function dateLabel(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN") : "永久有效";
}

function maskedAccountId(value: string | null | undefined) {
  if (!value) return "—";
  return `••••${value.slice(-6)}`;
}

async function clearDesktopSession() {
  await window.veridiaDesktop?.clearPersistentSession().catch(() => false);
}

export default function AccountSecurityPanel() {
  const { message } = App.useApp();
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(null);
  const [accounts, setAccounts] = useState<ManagedAccount[]>([]);
  const [passwordForm] = Form.useForm();
  const [updateCode, setUpdateCode] = useState("");
  const [resetTarget, setResetTarget] = useState<ManagedAccount | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [currentTime, setCurrentTime] = useState<number | null>(null);

  const load = useCallback(async () => {
    const user = await apiFetch<SessionUser | null>("/api/auth/me");
    setCurrentUser(user);
    if (user?.role === "ADMIN") {
      setAccounts(await apiFetch<ManagedAccount[]>("/api/users"));
    }
  }, []);

  useEffect(() => {
    setCurrentTime(Date.now());
    void load().catch((error) =>
      message.error(error instanceof Error ? error.message : "读取账号信息失败"),
    );
  }, [load, message]);

  const exitToLogin = async () => {
    await clearDesktopSession();
    window.location.assign("/login");
  };

  return (
    <>
      <Card
        className="surface-card"
        title="账号安全"
        style={{ marginBottom: 16 }}
      >
        <Descriptions column={{ xs: 1, md: 2, xl: 4 }}>
          <Descriptions.Item label="用户名">
            {currentUser?.username || "—"}
          </Descriptions.Item>
          <Descriptions.Item label="显示名称">
            {currentUser?.displayName || "—"}
          </Descriptions.Item>
          <Descriptions.Item label="角色">
            {currentUser ? roleLabels[currentUser.role] : "—"}
          </Descriptions.Item>
          <Descriptions.Item label="授权有效期">
            {dateLabel(currentUser?.expiresAt || null)}
          </Descriptions.Item>
          <Descriptions.Item label="账号标识" span={2}>
            {maskedAccountId(currentUser?.accountId)}
          </Descriptions.Item>
        </Descriptions>
        {currentUser?.expiresAt &&
          currentTime !== null &&
          new Date(currentUser.expiresAt).getTime() - currentTime <=
            7 * 24 * 60 * 60 * 1000 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message="账号授权将在 7 天内到期，请联系账号管理员办理续期。"
            />
          )}
        <Form
          form={passwordForm}
          layout="vertical"
          style={{ maxWidth: 560 }}
          onFinish={async (values) => {
            setBusy(true);
            try {
              await apiFetch("/api/auth/change-password", {
                method: "POST",
                body: JSON.stringify(values),
              });
              passwordForm.resetFields();
              message.success("密码已修改，请使用新密码重新登录");
              await exitToLogin();
            } finally {
              setBusy(false);
            }
          }}
        >
          <Space align="start" wrap>
            <Form.Item
              name="currentPassword"
              label="当前密码"
              rules={[{ required: true }]}
            >
              <Input.Password autoComplete="current-password" />
            </Form.Item>
            <Form.Item
              name="newPassword"
              label="新密码"
              rules={[
                { required: true },
                {
                  pattern: /^(?=.*[A-Za-z])(?=.*\d).{8,}$/u,
                  message: "至少8位，并同时包含字母和数字",
                },
              ]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Form.Item
              name="confirmPassword"
              label="确认新密码"
              dependencies={["newPassword"]}
              rules={[
                { required: true },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    return !value || getFieldValue("newPassword") === value
                      ? Promise.resolve()
                      : Promise.reject(new Error("两次新密码不一致"));
                  },
                }),
              ]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          </Space>
          <Space wrap>
            <Button type="primary" htmlType="submit" loading={busy}>
              修改本人密码
            </Button>
            <Button
              onClick={async () => {
                await apiFetch("/api/auth/logout", { method: "POST" });
                await exitToLogin();
              }}
            >
              退出登录
            </Button>
          </Space>
        </Form>
        <div style={{ marginTop: 20, maxWidth: 720 }}>
          <Input.TextArea
            value={updateCode}
            autoSize={{ minRows: 2, maxRows: 5 }}
            placeholder="粘贴账号管理员提供的更新码，用于续期、修改显示名称或调整角色"
            onChange={(event) => setUpdateCode(event.target.value)}
          />
          <Button
            style={{ marginTop: 8 }}
            disabled={!updateCode.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await apiFetch("/api/auth/update-code", {
                  method: "POST",
                  body: JSON.stringify({ updateCode }),
                });
                setUpdateCode("");
                message.success("账号更新成功，请重新登录");
                await exitToLogin();
              } finally {
                setBusy(false);
              }
            }}
          >
            导入账号更新码
          </Button>
        </div>
      </Card>

      {currentUser?.role === "ADMIN" && (
        <Card
          className="surface-card"
          title="本机账号管理"
          style={{ marginBottom: 16 }}
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="账号角色和有效期由授权管理员统一维护。如需变更，请导入管理员提供的账号更新码。"
          />
          <Table<ManagedAccount>
            rowKey="id"
            dataSource={accounts}
            scroll={{ x: 1180 }}
            pagination={false}
            columns={[
              { title: "用户名", dataIndex: "username", fixed: "left", width: 130 },
              { title: "显示名称", dataIndex: "displayName", width: 140 },
              {
                title: "角色",
                dataIndex: "role",
                width: 100,
                render: (value: SessionUser["role"]) => roleLabels[value],
              },
              {
                title: "状态",
                dataIndex: "status",
                width: 100,
                render: (value: ManagedAccount["status"]) => (
                  <Tag color={statusLabels[value].color}>
                    {statusLabels[value].label}
                  </Tag>
                ),
              },
              {
                title: "账号标识",
                dataIndex: "accountId",
                width: 140,
                render: (value: string) => maskedAccountId(value),
              },
              {
                title: "激活时间",
                dataIndex: "activatedAt",
                width: 180,
                render: dateLabel,
              },
              {
                title: "签发时间",
                dataIndex: "issuedAt",
                width: 180,
                render: dateLabel,
              },
              {
                title: "到期时间",
                dataIndex: "expiresAt",
                width: 180,
                render: dateLabel,
              },
              {
                title: "最近登录",
                dataIndex: "lastLocalLoginAt",
                width: 180,
                render: (value: string | null) => (value ? dateLabel(value) : "尚未登录"),
              },
              {
                title: "操作",
                fixed: "right",
                width: 190,
                render: (_value, row) =>
                  row.id === currentUser.id || row.role === "ADMIN" ? (
                    <span style={{ color: "#8b96a8" }}>由授权管理员维护</span>
                  ) : (
                    <Space size={4}>
                      <Popconfirm
                        title={row.status === "DISABLED" ? "确认恢复此账号？" : "确认停用此账号？"}
                        onConfirm={async () => {
                          await apiFetch(`/api/users/${row.id}`, {
                            method: "PATCH",
                            body: JSON.stringify({
                              action:
                                row.status === "DISABLED" ? "ENABLE" : "DISABLE",
                            }),
                          });
                          message.success("账号状态已更新");
                          await load();
                        }}
                      >
                        <Button type="link">
                          {row.status === "DISABLED" ? "恢复" : "停用"}
                        </Button>
                      </Popconfirm>
                      <Button type="link" onClick={() => setResetTarget(row)}>
                        重置密码
                      </Button>
                    </Space>
                  ),
              },
            ]}
          />
        </Card>
      )}

      <Modal
        open={Boolean(resetTarget)}
        title={`重置 ${resetTarget?.username || ""} 的密码`}
        okText="确认重置"
        cancelText="取消"
        confirmLoading={busy}
        onCancel={() => {
          setResetTarget(null);
          setResetPassword("");
        }}
        onOk={async () => {
          if (!resetTarget) return;
          setBusy(true);
          try {
            await apiFetch(`/api/users/${resetTarget.id}`, {
              method: "PATCH",
              body: JSON.stringify({
                action: "RESET_PASSWORD",
                newPassword: resetPassword,
              }),
            });
            message.success("密码已重置，该账号的旧会话已失效");
            setResetTarget(null);
            setResetPassword("");
            await load();
          } finally {
            setBusy(false);
          }
        }}
      >
        <Input.Password
          value={resetPassword}
          placeholder="新初始密码，至少8位并包含字母和数字"
          autoComplete="new-password"
          onChange={(event) => setResetPassword(event.target.value)}
        />
      </Modal>
    </>
  );
}
