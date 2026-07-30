"use client";

import { useState } from "react";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Input,
  Space,
  Typography,
} from "antd";
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

interface AccountActivationPreview {
  accountId: string;
  username: string;
  displayName: string;
  role: string;
  expiresAt: string | null;
  requiresPassword: boolean;
  codeFormat: "VRD1" | "VRD2";
}

function expiryLabel(expiresAt: string | null) {
  return expiresAt
    ? new Date(expiresAt).toLocaleDateString("zh-CN")
    : "永久";
}

export default function AccountActivationForm({
  onActivated,
}: {
  onActivated?: (account: ActivatedAccountSummary) => void;
}) {
  const { message } = App.useApp();
  const [activationCode, setActivationCode] = useState("");
  const [preview, setPreview] = useState<AccountActivationPreview | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState<ActivatedAccountSummary | null>(null);

  const verify = async () => {
    setBusy(true);
    try {
      const value = await apiFetch<AccountActivationPreview>(
        "/api/auth/activate",
        {
          method: "POST",
          body: JSON.stringify({ activationCode, preview: true }),
        },
      );
      setPreview(value);
      setPassword("");
      setConfirmPassword("");
      message.success("激活码签名验证通过。");
    } catch (error) {
      setPreview(null);
      message.error(
        error instanceof Error ? error.message : "账号激活码无效。",
      );
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    if (preview?.requiresPassword) {
      if (!password || !confirmPassword) {
        message.error("请设置并确认本地登录密码。");
        return;
      }
      if (password !== confirmPassword) {
        message.error("两次输入的密码不一致。");
        return;
      }
    }
    setBusy(true);
    try {
      const activated = await apiFetch<ActivatedAccountSummary>(
        "/api/auth/activate",
        {
          method: "POST",
          body: JSON.stringify({
            activationCode,
            ...(preview?.requiresPassword
              ? { password, confirmPassword }
              : {}),
          }),
        },
      );
      setActivationCode("");
      setPassword("");
      setConfirmPassword("");
      setAccount(activated);
      message.success("VERIDIA 账号激活成功。");
      onActivated?.(activated);
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : "账号激活失败。",
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
            <span>账号：{account.username}</span>
            <span>显示名称：{account.displayName}</span>
            <span>角色：{account.role}</span>
            <span>有效期：{expiryLabel(account.expiresAt)}</span>
            <span>请前往登录页面，使用刚刚设置的密码登录。</span>
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
          激活码和密码只在本机处理，不会发送到任何服务器。
        </Typography.Text>
      </div>

      <Input.TextArea
        value={activationCode}
        onChange={(event) => {
          setActivationCode(event.target.value);
          setPreview(null);
        }}
        autoSize={{ minRows: 4, maxRows: 8 }}
        placeholder="粘贴开发者提供的账号激活码"
        spellCheck={false}
        autoComplete="off"
      />

      {!preview && (
        <Space wrap>
          <Button
            icon={<CopyOutlined />}
            onClick={async () => {
              const text = await navigator.clipboard.readText();
              setActivationCode(text);
              setPreview(null);
            }}
          >
            粘贴激活码
          </Button>
          <Button
            type="primary"
            icon={<SafetyCertificateOutlined />}
            loading={busy}
            disabled={!activationCode.trim()}
            onClick={() => void verify()}
          >
            验证激活码
          </Button>
        </Space>
      )}

      {preview && (
        <>
          <Alert
            type="success"
            showIcon
            message="激活码签名验证通过"
            description={
              preview.codeFormat === "VRD2"
                ? "请设置此账号在本机使用的登录密码。"
                : "这是兼容的旧版激活码，将继续使用原初始密码。"
            }
          />
          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label="账号">
              {preview.username}
            </Descriptions.Item>
            <Descriptions.Item label="显示名称">
              {preview.displayName}
            </Descriptions.Item>
            <Descriptions.Item label="角色">
              {preview.role}
            </Descriptions.Item>
            <Descriptions.Item label="有效期">
              {expiryLabel(preview.expiresAt)}
            </Descriptions.Item>
          </Descriptions>

          {preview.requiresPassword && (
            <Space direction="vertical" size={10} style={{ width: "100%" }}>
              <div>
                <Typography.Text strong>设置登录密码</Typography.Text>
                <Typography.Paragraph
                  type="secondary"
                  style={{ marginBottom: 6 }}
                >
                  密码至少 8 位，并同时包含字母和数字。密码哈希仅写入本地
                  SQLite。
                </Typography.Paragraph>
                <Input.Password
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="请输入登录密码"
                  autoComplete="new-password"
                />
              </div>
              <div>
                <Typography.Text strong>确认登录密码</Typography.Text>
                <Input.Password
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="请再次输入登录密码"
                  autoComplete="new-password"
                />
              </div>
            </Space>
          )}

          <Space wrap>
            <Button
              onClick={() => {
                setPreview(null);
                setPassword("");
                setConfirmPassword("");
              }}
            >
              返回修改
            </Button>
            <Button
              type="primary"
              icon={<SafetyCertificateOutlined />}
              loading={busy}
              onClick={() => void activate()}
            >
              确认激活
            </Button>
          </Space>
        </>
      )}
    </Space>
  );
}
