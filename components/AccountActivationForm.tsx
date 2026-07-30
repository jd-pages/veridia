"use client";

import { useState } from "react";
import { Alert, App, Button, Input, Space, Typography } from "antd";
import { CopyOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { apiFetch } from "@/lib/client";

export interface ActivatedAccountSummary {
  accountId: string;
  username: string;
  displayName: string;
  role: string;
  status: string;
  expiresAt: string | null;
}

export default function AccountActivationForm({
  onActivated,
}: {
  onActivated?: (account: ActivatedAccountSummary) => void;
}) {
  const { message } = App.useApp();
  const [activationCode, setActivationCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState<ActivatedAccountSummary | null>(null);

  const activate = async () => {
    setBusy(true);
    try {
      const activated = await apiFetch<ActivatedAccountSummary>(
        "/api/auth/activate",
        {
          method: "POST",
          body: JSON.stringify({ activationCode }),
        },
      );
      setActivationCode("");
      setAccount(activated);
      message.success("VERIDIA 账号激活成功");
      onActivated?.(activated);
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : "账号激活码无效",
      );
    } finally {
      setBusy(false);
    }
  };

  if (account) {
    return (
      <Alert
        type="success"
        showIcon
        message="账号激活成功"
        description={
          <Space direction="vertical" size={2}>
            <span>用户名：{account.username}</span>
            <span>显示名称：{account.displayName}</span>
            <span>角色：{account.role}</span>
            <span>
              授权有效期：
              {account.expiresAt
                ? new Date(account.expiresAt).toLocaleString("zh-CN")
                : "永久有效"}
            </span>
          </Space>
        }
      />
    );
  }

  return (
    <Space direction="vertical" size={14} style={{ width: "100%" }}>
      <div>
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          激活 VERIDIA 账号
        </Typography.Title>
        <Typography.Text type="secondary">
          激活码只在本机验证，不会发送到任何服务器。
        </Typography.Text>
      </div>
      <Input.TextArea
        value={activationCode}
        onChange={(event) => setActivationCode(event.target.value)}
        autoSize={{ minRows: 5, maxRows: 9 }}
        placeholder="粘贴开发者提供的账号激活码"
        spellCheck={false}
        autoComplete="off"
      />
      <Space wrap>
        <Button
          icon={<CopyOutlined />}
          onClick={async () => {
            const text = await navigator.clipboard.readText();
            setActivationCode(text);
          }}
        >
          粘贴激活码
        </Button>
        <Button
          type="primary"
          icon={<SafetyCertificateOutlined />}
          loading={busy}
          disabled={!activationCode.trim()}
          onClick={() => void activate()}
        >
          验证并激活
        </Button>
      </Space>
    </Space>
  );
}
