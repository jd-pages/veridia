"use client";

import "@ant-design/v5-patch-for-react-19";
import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  ConfigProvider,
  Descriptions,
  Form,
  Input,
  Space,
  Steps,
  Typography,
} from "antd";
import zhCN from "antd/locale/zh_CN";
import {
  CheckCircleOutlined,
  CloudSyncOutlined,
  FolderOpenOutlined,
  LoginOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/client";
import AccountActivationForm from "@/components/AccountActivationForm";
import VeridiaLogo from "@/components/VeridiaLogo";
import { ruleSyncStatusLabel } from "@/lib/rules/labels";

interface RuleSyncStatus {
  configured: boolean;
  currentVersion: string;
  latestVersion: string | null;
  status: string;
  counts: {
    products: number;
    activities: number;
    stageGroups: number;
    topicRules: number;
  };
}

interface SetupStatus {
  initialized: boolean;
  dataDirectory: string;
  desktop: boolean;
  dataLocationConfirmed: boolean;
  activatedAccountCount: number;
  authenticated: boolean;
  canVerifyActivation: boolean;
  rules: RuleSyncStatus;
}

function SetupContent() {
  const router = useRouter();
  const { message } = App.useApp();
  const [current, setCurrent] = useState(0);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [rules, setRules] = useState<RuleSyncStatus | null>(null);
  const [selectedDataDirectory, setSelectedDataDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [loginStarted, setLoginStarted] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [desktopBridgeAvailable, setDesktopBridgeAvailable] = useState(false);

  useEffect(() => {
    setDesktopBridgeAvailable(Boolean(window.veridiaDesktop));
    apiFetch<SetupStatus>("/api/setup/status")
      .then((value) => {
        setLoadError("");
        setStatus(value);
        setRules(value.rules);
        setSelectedDataDirectory(value.dataDirectory);
        if (value.initialized) {
          router.replace("/dashboard");
        } else if (!value.dataLocationConfirmed && value.desktop) {
          setCurrent(0);
        } else if (!value.activatedAccountCount) {
          setCurrent(1);
        } else if (!value.authenticated) {
          setCurrent(2);
        } else {
          setCurrent(3);
        }
      })
      .catch((error) => {
        const errorMessage =
          error instanceof Error ? error.message : "读取初始化状态失败";
        setLoadError(errorMessage);
        message.error(errorMessage);
      });
  }, [message, router]);

  const syncRules = async () => {
    setBusy(true);
    try {
      const next = await apiFetch<RuleSyncStatus>("/api/rule-sync/apply", {
        method: "POST",
      });
      setRules(next);
      message.success("审核规则同步完成");
    } catch (error) {
      message.warning(
        error instanceof Error
          ? error.message
          : "暂时无法获取最新规则，已继续使用本地规则。",
      );
    } finally {
      setBusy(false);
    }
  };

  const finishSetup = async () => {
    await apiFetch("/api/setup/complete", { method: "POST" });
    router.replace("/dashboard");
    router.refresh();
  };

  return (
    <main className="setup-page">
      <Card className="setup-card">
        <div className="setup-brand">
          <VeridiaLogo theme="light" size={46} />
          <div>
            <strong>VERIDIA</strong>
            <span>CONTENT GOVERNANCE</span>
          </div>
        </div>
        <Typography.Title level={2}>首次启动设置</Typography.Title>
        <Typography.Paragraph type="secondary">
          账号、数据库、审核记录及登录状态只保存在本机，不会上传到账号服务器。
        </Typography.Paragraph>
        {!desktopBridgeAvailable && (
          <Alert
            type="info"
            showIcon
            message="当前页面在普通浏览器中打开"
            description="数据位置选择、桌面凭证保存等功能仅在 VERIDIA 桌面程序中可用。请从桌面快捷方式启动 VERIDIA；普通浏览器可用于查看服务状态。"
          />
        )}
        {loadError && (
          <Alert
            type="error"
            showIcon
            message="首次启动状态读取失败"
            description={loadError}
          />
        )}
        <Steps
          current={current}
          items={[
            { title: "数据位置" },
            { title: "激活账号" },
            { title: "登录 VERIDIA" },
            { title: "同步规则" },
            { title: "登录小红书" },
            { title: "完成" },
          ]}
        />

        <section className="setup-step">
          {current === 0 && (
            <>
              <FolderOpenOutlined className="setup-step-icon" />
              <Typography.Title level={3}>选择数据保存位置</Typography.Title>
              <Typography.Paragraph type="secondary">
                数据库、审核记录、系统设置及登录状态将保存在此目录。
                <br />
                软件升级不会覆盖该目录。
              </Typography.Paragraph>
              <Alert
                type="info"
                showIcon
                message={`当前数据位置：${
                  selectedDataDirectory || status?.dataDirectory || "正在读取"
                }`}
              />
              <Space>
                <Button type="primary" size="large" onClick={() => setCurrent(1)}>
                  使用默认位置
                </Button>
                <Button
                  size="large"
                  disabled={!status?.desktop || !desktopBridgeAvailable}
                  onClick={async () => {
                    const result =
                      await window.veridiaDesktop?.chooseDataDirectory();
                    if (!result?.success || !result.dataDirectory) {
                      if (result) message.error(result.error || "所选目录不可用");
                      return;
                    }
                    const confirmed =
                      await window.veridiaDesktop?.confirmDataDirectory(
                        result.dataDirectory,
                      );
                    if (!confirmed?.success) {
                      message.error(confirmed?.error || "保存数据位置失败");
                      return;
                    }
                    setSelectedDataDirectory(result.dataDirectory);
                    setCurrent(1);
                  }}
                >
                  更改保存位置
                </Button>
              </Space>
            </>
          )}

          {current === 1 && (
            <>
              <SafetyCertificateOutlined className="setup-step-icon" />
              {!status?.canVerifyActivation && (
                <Alert
                  type="error"
                  showIcon
                  message="当前软件无法验证账号授权，请联系账号管理员处理。"
                />
              )}
              <AccountActivationForm onActivated={() => setCurrent(2)} />
            </>
          )}

          {current === 2 && (
            <>
              <LoginOutlined className="setup-step-icon" />
              <Typography.Title level={3}>登录 VERIDIA</Typography.Title>
              <Form
                layout="vertical"
                className="setup-form"
                onFinish={async (values) => {
                  setBusy(true);
                  try {
                    const result = await apiFetch<{
                      persistentToken: string;
                    }>("/api/auth/login", {
                      method: "POST",
                      body: JSON.stringify(values),
                    });
                    await window.veridiaDesktop?.storePersistentSession(
                      result.persistentToken,
                    );
                    setCurrent(3);
                  } catch (error) {
                    message.error(
                      error instanceof Error
                        ? error.message
                        : "用户名或密码错误。",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Form.Item
                  name="username"
                  label="用户名"
                  rules={[{ required: true, message: "请输入用户名" }]}
                >
                  <Input autoCapitalize="none" />
                </Form.Item>
                <Form.Item
                  name="password"
                  label="密码"
                  rules={[{ required: true, message: "请输入密码" }]}
                >
                  <Input.Password autoComplete="current-password" />
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={busy}>
                  登录
                </Button>
              </Form>
            </>
          )}

          {current === 3 && (
            <>
              <CloudSyncOutlined className="setup-step-icon" />
              <Typography.Title level={3}>同步审核规则</Typography.Title>
              <Descriptions bordered size="small" column={2}>
                <Descriptions.Item label="当前规则版本">
                  {rules?.currentVersion || "—"}
                </Descriptions.Item>
                <Descriptions.Item label="最新规则版本">
                  {rules?.latestVersion || "尚未检查"}
                </Descriptions.Item>
                <Descriptions.Item label="产品数量">
                  {rules?.counts.products ?? 0}
                </Descriptions.Item>
                <Descriptions.Item label="活动数量">
                  {rules?.counts.activities ?? 0}
                </Descriptions.Item>
                <Descriptions.Item label="阶段组数量">
                  {rules?.counts.stageGroups ?? 0}
                </Descriptions.Item>
                <Descriptions.Item label="同步状态">
                  {ruleSyncStatusLabel(rules?.status)}
                </Descriptions.Item>
              </Descriptions>
              <Space>
                <Button
                  type="primary"
                  loading={busy}
                  disabled={!rules?.configured}
                  onClick={() => void syncRules()}
                >
                  立即同步
                </Button>
                <Button onClick={() => setCurrent(4)}>
                  使用当前规则继续
                </Button>
              </Space>
            </>
          )}

          {current === 4 && (
            <>
              <LoginOutlined className="setup-step-icon" />
              <Typography.Title level={3}>登录小红书</Typography.Title>
              <Typography.Paragraph type="secondary">
                请在专用浏览器中手动完成登录或安全验证。Cookie
                和浏览器会话只保存在本机。
              </Typography.Paragraph>
              <Space>
                <Button
                  type="primary"
                  loading={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await apiFetch("/api/automation/session", {
                        method: "POST",
                        body: JSON.stringify({ action: "START_LOGIN" }),
                      });
                      setLoginStarted(true);
                      message.info("请在已打开的专用浏览器中完成登录");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  登录小红书
                </Button>
                <Button
                  disabled={!loginStarted}
                  onClick={async () => {
                    await apiFetch("/api/automation/session", {
                      method: "POST",
                      body: JSON.stringify({ action: "COMPLETE_LOGIN" }),
                    });
                    setCurrent(5);
                  }}
                >
                  我已完成登录
                </Button>
                <Button onClick={() => setCurrent(5)}>稍后登录</Button>
              </Space>
            </>
          )}

          {current === 5 && (
            <>
              <CheckCircleOutlined className="setup-step-icon setup-success" />
              <Typography.Title level={3}>VERIDIA 已准备就绪</Typography.Title>
              <Button type="primary" size="large" onClick={() => void finishSetup()}>
                进入工作台
              </Button>
            </>
          )}
        </section>
      </Card>
    </main>
  );
}

export default function SetupPage() {
  return (
    <ConfigProvider locale={zhCN}>
      <App>
        <SetupContent />
      </App>
    </ConfigProvider>
  );
}
