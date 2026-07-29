"use client";

import "@ant-design/v5-patch-for-react-19";
import { useEffect, useState } from "react";
import { Alert, Button, Form, Input } from "antd";
import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/client";
import VeridiaLogo from "@/components/VeridiaLogo";

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => setReady(true), []);
  useEffect(() => {
    apiFetch<{ initialized: boolean }>("/api/setup/status")
      .then((status) => {
        if (!status.initialized) router.replace("/setup");
      })
      .catch(() => undefined);
  }, [router]);

  return (
    <div className="login-page">
      <section className="login-story">
        <div className="login-story-content">
          <div className="login-brand-lockup">
            <VeridiaLogo theme="dark" size={40} title="VERIDIA V-Core" />
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
        <div className="login-form">
          <VeridiaLogo
            className="login-form-logo"
            theme="light"
            size={42}
            title="VERIDIA V-Core"
          />
          <h2>
            登录 <span>VERIDIA</span>
          </h2>
          {error ? <Alert type="error" message={error} showIcon style={{ marginBottom: 18 }} /> : null}
          <Form
            layout="vertical"
            onFinish={async (values: { username: string; password: string }) => {
              setLoading(true);
              setError("");
              try {
                await apiFetch("/api/auth/login", {
                  method: "POST",
                  body: JSON.stringify(values),
                });
                router.replace("/dashboard");
                router.refresh();
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : "登录失败");
              } finally {
                setLoading(false);
              }
            }}
          >
            <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
              <Input size="large" prefix={<UserOutlined />} autoComplete="username" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true }]}>
              <Input.Password
                size="large"
                prefix={<LockOutlined />}
                autoComplete="current-password"
              />
            </Form.Item>
            <Button
              aria-label="登入"
              type="primary"
              htmlType="submit"
              size="large"
              block
              disabled={!ready}
              loading={loading}
            >
              登入
            </Button>
          </Form>
        </div>
      </section>
    </div>
  );
}
