"use client";

import "@ant-design/v5-patch-for-react-19";
import { useEffect, useState } from "react";
import { Alert, App, Button, Card, Descriptions, Space, Steps, Typography } from "antd";
import {
  CheckCircleOutlined,
  CloudSyncOutlined,
  FolderOpenOutlined,
  LoginOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/client";
import VeridiaLogo from "@/components/VeridiaLogo";
import { ruleSyncStatusLabel } from "@/lib/rules/labels";

interface RuleSyncStatus {
  configured: boolean;
  currentVersion: string;
  latestVersion: string | null;
  schemaVersion: number;
  source: string;
  status: string;
  counts: {
    products: number;
    activities: number;
    stageGroups: number;
    topicRules: number;
  };
  lastSyncedAt: string | null;
}

interface SetupStatus {
  initialized: boolean;
  dataDirectory: string;
  desktop: boolean;
  dataLocationConfirmed: boolean;
  rules: RuleSyncStatus;
}

export default function SetupPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [current, setCurrent] = useState(0);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [rules, setRules] = useState<RuleSyncStatus | null>(null);
  const [selectedDataDirectory, setSelectedDataDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [loginStarted, setLoginStarted] = useState(false);

  useEffect(() => {
    apiFetch<SetupStatus>("/api/setup/status")
      .then((value) => {
        setStatus(value);
        setRules(value.rules);
        setSelectedDataDirectory(value.dataDirectory);
        if (value.initialized) router.replace("/dashboard");
        else if (value.dataLocationConfirmed) setCurrent(1);
      })
      .catch((error) =>
        message.error(error instanceof Error ? error.message : "读取初始化状态失败"),
      );
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

  const startLogin = async () => {
    setBusy(true);
    try {
      await apiFetch("/api/automation/session", {
        method: "POST",
        body: JSON.stringify({ action: "START_LOGIN" }),
      });
      setLoginStarted(true);
      message.info("请在已打开的专用浏览器中完成小红书登录");
    } finally {
      setBusy(false);
    }
  };

  const confirmLogin = async () => {
    setBusy(true);
    try {
      const session = await apiFetch<{ status: string; lastError?: string | null }>(
        "/api/automation/session",
        {
          method: "POST",
          body: JSON.stringify({ action: "COMPLETE_LOGIN" }),
        },
      );
      if (session.status !== "READY") {
        throw new Error(session.lastError || "尚未确认小红书登录状态");
      }
      setCurrent(3);
      message.success("小红书登录状态已保存在本机");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "确认登录失败");
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
          审核数据、规则缓存和小红书登录状态仅保存在本机，无需创建账号或登录。
        </Typography.Paragraph>
        <Steps
          current={current}
          items={[
            { title: "数据位置" },
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
                  disabled={!status?.desktop}
                  onClick={async () => {
                    const result =
                      await window.veridiaDesktop?.chooseDataDirectory();
                    if (!result) return;
                    if (!result.success || !result.dataDirectory) {
                      message.error(result.error || "所选目录不可用");
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
              <CloudSyncOutlined className="setup-step-icon" />
              <Typography.Title level={3}>同步审核规则</Typography.Title>
              <Typography.Paragraph type="secondary">
                VERIDIA 将检查最新的产品、活动和审核规则。
                <br />
                规则同步失败时，仍可使用内置规则继续工作。
              </Typography.Paragraph>
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
                <Descriptions.Item label="话题规则数量">
                  {rules?.counts.topicRules ?? 0}
                </Descriptions.Item>
                <Descriptions.Item label="最近同步时间">
                  {rules?.lastSyncedAt
                    ? new Date(rules.lastSyncedAt).toLocaleString("zh-CN")
                    : "使用内置规则"}
                </Descriptions.Item>
                <Descriptions.Item label="当前同步状态">
                  {ruleSyncStatusLabel(rules?.status)}
                </Descriptions.Item>
              </Descriptions>
              {!rules?.configured && (
                <Alert
                  showIcon
                  type="info"
                  message="尚未配置独立 GitHub 规则仓库，当前使用内置规则。"
                />
              )}
              <Space>
                <Button
                  type="primary"
                  loading={busy}
                  disabled={!rules?.configured}
                  onClick={() => void syncRules()}
                >
                  立即同步
                </Button>
                <Button onClick={() => setCurrent(2)}>使用内置规则继续</Button>
              </Space>
            </>
          )}

          {current === 2 && (
            <>
              <LoginOutlined className="setup-step-icon" />
              <Typography.Title level={3}>登录小红书</Typography.Title>
              <Typography.Paragraph type="secondary">
                请在专用浏览器中手动完成登录或安全验证。Cookie
                和浏览器会话只保存在本机。
              </Typography.Paragraph>
              <Space>
                <Button type="primary" loading={busy} onClick={() => void startLogin()}>
                  登录小红书
                </Button>
                <Button
                  disabled={!loginStarted}
                  loading={busy}
                  onClick={() => void confirmLogin()}
                >
                  我已完成登录
                </Button>
                <Button onClick={() => setCurrent(3)}>稍后登录</Button>
              </Space>
            </>
          )}

          {current === 3 && (
            <>
              <CheckCircleOutlined className="setup-step-icon setup-success" />
              <Typography.Title level={3}>VERIDIA 已准备就绪</Typography.Title>
              <Typography.Paragraph type="secondary">
                本地审核、Excel 导入导出与历史结果查看均不依赖网络或第三方服务。
              </Typography.Paragraph>
              <Button type="primary" size="large" onClick={() => void finishSetup()}>
                进入系统
              </Button>
            </>
          )}
        </section>
      </Card>
    </main>
  );
}
