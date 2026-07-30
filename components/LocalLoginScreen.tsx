"use client";

import "@ant-design/v5-patch-for-react-19";
import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  ConfigProvider,
  Form,
  Input,
  Modal,
  Space,
  Typography,
} from "antd";
import zhCN from "antd/locale/zh_CN";
import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/client";
import VeridiaLogo from "@/components/VeridiaLogo";

interface LoginValues {
  username: string;
  password: string;
}

interface LoginResponse {
  persistentToken: string;
  user: {
    id: string;
    username: string;
    displayName: string;
    role: string;
  };
}

export default function LocalLoginScreen() {
  const router = useRouter();
  const [form] = Form.useForm<LoginValues>();
  const [busy, setBusy] = useState(false);
  const [activatedAccountCount, setActivatedAccountCount] = useState<
    number | null
  >(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [resetCode, setResetCode] = useState("");
  const [updateCode, setUpdateCode] = useState("");

  useEffect(() => {
    // If the server rendered the login screen, any desktop-persisted token was
    // already rejected (missing user, expired authorization or damaged token).
    void window.veridiaDesktop?.clearPersistentSession().catch(() => false);
    apiFetch<{ activatedAccountCount: number }>("/api/auth/status")
      .then((status) => setActivatedAccountCount(status.activatedAccountCount))
      .catch(() => setActivatedAccountCount(0));
  }, []);

  const submit = async (values: LoginValues) => {
    setBusy(true);
    try {
      const result = await apiFetch<LoginResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(values),
      });
      await window.veridiaDesktop?.storePersistentSession(
        result.persistentToken,
      );
      form.setFieldValue("password", "");
      router.replace("/dashboard");
      router.refresh();
    } catch (error) {
      form.setFieldValue("password", "");
      Modal.error({
        title: "登录失败",
        content:
          error instanceof Error ? error.message : "用户名或密码错误。",
      });
    } finally {
      setBusy(false);
    }
  };

  const content = (
    <main className="login-page">
      <section className="login-story">
        <div className="login-story-content">
          <div className="login-brand-lockup">
            <VeridiaLogo theme="dark" size={44} />
            <div className="login-brand-wordmark">
              <span>VERIDIA</span>
              <small>CONTENT GOVERNANCE</small>
            </div>
          </div>
          <h1>秩序，始于每一次判断。</h1>
          <p>
            VERIDIA 以统一标准贯通规则、任务与结果，
            <br />
            让复杂的内容审核更清晰、更稳定、更可追溯。
          </p>
        </div>
      </section>
      <section className="login-panel">
        <Form<LoginValues>
          form={form}
          className="login-form"
          layout="vertical"
          onFinish={submit}
          autoComplete="off"
        >
          <div className="login-form-logo">
            <VeridiaLogo theme="light" size={54} />
          </div>
          <h2>
            登录 <span>VERIDIA</span>
          </h2>
          {activatedAccountCount === 0 && (
            <Alert
              type="warning"
              showIcon
              message="当前设备尚未激活 VERIDIA 账号。"
              action={
                <Button type="link" href="/activate">
                  激活账号
                </Button>
              }
            />
          )}
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: "请输入用户名" }]}
          >
            <Input
              prefix={<UserOutlined />}
              placeholder="请输入用户名"
              autoCapitalize="none"
            />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: "请输入密码" }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="请输入密码"
              autoComplete="current-password"
            />
          </Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            loading={busy}
            block
          >
            登录
          </Button>
          <Space wrap size={4}>
            <Button type="link" href="/activate">
              激活账号
            </Button>
            <Button type="link" onClick={() => setResetOpen(true)}>
              导入密码重置码
            </Button>
            <Button type="link" onClick={() => setUpdateOpen(true)}>
              导入账号更新码
            </Button>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            账号与登录凭证仅保存在本机，不提供在线注册或在线找回密码。
          </Typography.Text>
        </Form>
      </section>
    </main>
  );

  return (
    <ConfigProvider locale={zhCN}>
      <App>
        {content}
        <Modal
          title="导入密码重置码"
          open={resetOpen}
          onCancel={() => setResetOpen(false)}
          okText="验证并重置"
          onOk={async () => {
            await apiFetch("/api/auth/reset-code", {
              method: "POST",
              body: JSON.stringify({ resetCode }),
            });
            await window.veridiaDesktop?.clearPersistentSession();
            setResetCode("");
            setResetOpen(false);
            Modal.success({
              title: "密码已重置",
              content: "请使用开发者提供的新初始密码登录。",
            });
          }}
        >
          <Input.TextArea
            value={resetCode}
            onChange={(event) => setResetCode(event.target.value)}
            autoSize={{ minRows: 5, maxRows: 9 }}
            placeholder="粘贴密码重置码"
          />
        </Modal>
        <Modal
          title="导入账号更新码"
          open={updateOpen}
          onCancel={() => setUpdateOpen(false)}
          okText="验证并更新"
          onOk={async () => {
            await apiFetch("/api/auth/update-code", {
              method: "POST",
              body: JSON.stringify({ updateCode }),
            });
            await window.veridiaDesktop?.clearPersistentSession();
            setUpdateCode("");
            setUpdateOpen(false);
            Modal.success({
              title: "账号信息已更新",
              content: "请重新登录以应用最新授权。",
            });
          }}
        >
          <Input.TextArea
            value={updateCode}
            onChange={(event) => setUpdateCode(event.target.value)}
            autoSize={{ minRows: 5, maxRows: 9 }}
            placeholder="粘贴账号更新码"
          />
        </Modal>
      </App>
    </ConfigProvider>
  );
}
