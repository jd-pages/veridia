"use client";

import "@ant-design/v5-patch-for-react-19";
import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  Space,
  Steps,
  Typography,
  Upload,
} from "antd";
import {
  CheckCircleOutlined,
  FolderOpenOutlined,
  LoginOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import type { UploadFile } from "antd";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/client";
import VeridiaLogo from "@/components/VeridiaLogo";

interface SetupStatus {
  initialized: boolean;
  dataDirectory: string;
  desktop: boolean;
  aiEnabled: boolean;
}

interface ImportMetadata {
  campaignName: string;
  month: string;
  startDate: string;
  endDate: string;
}

export default function SetupPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [current, setCurrent] = useState(0);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [previewReady, setPreviewReady] = useState(false);
  const [loginStarted, setLoginStarted] = useState(false);
  const [adminForm] = Form.useForm();
  const [importForm] = Form.useForm<ImportMetadata>();

  useEffect(() => {
    apiFetch<SetupStatus>("/api/setup/status")
      .then((value) => {
        setStatus(value);
        if (value.initialized) setCurrent(2);
      })
      .catch((error) =>
        message.error(error instanceof Error ? error.message : "读取初始化状态失败"),
      );
  }, [message]);

  const initializeAdmin = async () => {
    const values = await adminForm.validateFields();
    setBusy(true);
    try {
      await apiFetch("/api/setup/initialize", {
        method: "POST",
        body: JSON.stringify(values),
      });
      setCurrent(2);
      message.success("管理员账号已创建");
    } finally {
      setBusy(false);
    }
  };

  const importRules = async (commit: boolean) => {
    const file = fileList[0]?.originFileObj;
    if (!file) {
      message.warning("请选择产品和规则 Excel 文件");
      return;
    }
    const metadata = await importForm.validateFields();
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("commit", String(commit));
      form.append("metadata", JSON.stringify(metadata));
      const result = await apiFetch<{
        counts: { products: number; topicRules: number };
      }>("/api/rule-import", { method: "POST", body: form });
      if (commit) {
        message.success(
          `已导入 ${result.counts.products} 个产品、${result.counts.topicRules} 条话题规则`,
        );
        setCurrent(3);
      } else {
        setPreviewReady(true);
        message.success(
          `预检查通过：${result.counts.products} 个产品、${result.counts.topicRules} 条话题规则`,
        );
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "Excel 处理失败");
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
      setCurrent(4);
      message.success("小红书登录状态已保存在本机");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "确认登录失败");
    } finally {
      setBusy(false);
    }
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
          数据、账号和小红书登录状态仅保存在这台电脑。桌面版不使用任何 AI 服务。
        </Typography.Paragraph>
        <Steps
          current={current}
          items={[
            { title: "数据位置" },
            { title: "管理员" },
            { title: "导入规则" },
            { title: "登录小红书" },
            { title: "完成" },
          ]}
        />

        <section className="setup-step">
          {current === 0 && (
            <>
              <FolderOpenOutlined className="setup-step-icon" />
              <Typography.Title level={3}>确认数据保存位置</Typography.Title>
              <Alert
                type="info"
                showIcon
                message={status?.dataDirectory || "正在读取数据目录"}
                description="数据库、日志、备份和小红书登录会话会保存在此目录，软件升级不会覆盖。"
              />
              <Button type="primary" size="large" onClick={() => setCurrent(1)}>
                使用此位置
              </Button>
            </>
          )}

          {current === 1 && (
            <>
              <Typography.Title level={3}>创建管理员账号</Typography.Title>
              <Form form={adminForm} layout="vertical" className="setup-form">
                <Form.Item
                  name="displayName"
                  label="管理员姓名"
                  rules={[{ required: true, message: "请输入管理员姓名" }]}
                >
                  <Input size="large" autoComplete="name" />
                </Form.Item>
                <Form.Item
                  name="username"
                  label="登录用户名"
                  rules={[{ required: true, message: "请输入登录用户名" }]}
                >
                  <Input size="large" autoComplete="username" />
                </Form.Item>
                <Form.Item
                  name="password"
                  label="密码"
                  rules={[{ required: true }, { min: 8, message: "至少 8 位" }]}
                >
                  <Input.Password size="large" autoComplete="new-password" />
                </Form.Item>
                <Form.Item
                  name="confirmPassword"
                  label="确认密码"
                  dependencies={["password"]}
                  rules={[
                    { required: true },
                    ({ getFieldValue }) => ({
                      validator(_, value) {
                        return !value || getFieldValue("password") === value
                          ? Promise.resolve()
                          : Promise.reject(new Error("两次输入的密码不一致"));
                      },
                    }),
                  ]}
                >
                  <Input.Password size="large" autoComplete="new-password" />
                </Form.Item>
              </Form>
              <Button
                type="primary"
                size="large"
                loading={busy}
                onClick={() => void initializeAdmin()}
              >
                创建管理员
              </Button>
            </>
          )}

          {current === 2 && (
            <>
              <UploadOutlined className="setup-step-icon" />
              <Typography.Title level={3}>导入产品和活动规则 Excel</Typography.Title>
              <Form form={importForm} layout="vertical" className="setup-form">
                <Form.Item name="campaignName" label="活动名称" rules={[{ required: true }]}>
                  <Input placeholder="例如：2026年7月小红书活动" />
                </Form.Item>
                <Space size={12} style={{ width: "100%" }} align="start">
                  <Form.Item name="month" label="活动月份" rules={[{ required: true }]}>
                    <Input type="month" />
                  </Form.Item>
                  <Form.Item name="startDate" label="开始日期" rules={[{ required: true }]}>
                    <Input type="date" />
                  </Form.Item>
                  <Form.Item name="endDate" label="结束日期" rules={[{ required: true }]}>
                    <Input type="date" />
                  </Form.Item>
                </Space>
              </Form>
              <Upload
                accept=".xlsx,.xls"
                maxCount={1}
                fileList={fileList}
                beforeUpload={() => false}
                onChange={({ fileList: next }) => {
                  setFileList(next);
                  setPreviewReady(false);
                }}
              >
                <Button icon={<UploadOutlined />}>选择 Excel 文件</Button>
              </Upload>
              <Space>
                <Button loading={busy} onClick={() => void importRules(false)}>
                  导入预检查
                </Button>
                <Button
                  type="primary"
                  loading={busy}
                  disabled={!previewReady}
                  onClick={() => void importRules(true)}
                >
                  确认导入
                </Button>
                <Button onClick={() => setCurrent(3)}>稍后导入</Button>
              </Space>
            </>
          )}

          {current === 3 && (
            <>
              <LoginOutlined className="setup-step-icon" />
              <Typography.Title level={3}>登录小红书</Typography.Title>
              <Typography.Paragraph type="secondary">
                软件会打开专用浏览器。请手动完成登录、扫码或安全验证，VERIDIA
                不会绕过平台限制，也不会上传 Cookie。
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
                <Button onClick={() => setCurrent(4)}>稍后登录</Button>
              </Space>
            </>
          )}

          {current === 4 && (
            <>
              <CheckCircleOutlined className="setup-step-icon setup-success" />
              <Typography.Title level={3}>VERIDIA 已准备就绪</Typography.Title>
              <Typography.Paragraph type="secondary">
                固定规则审核、Excel 导入导出和本地历史数据管理均无需 AI 或网络服务。
              </Typography.Paragraph>
              <Button
                type="primary"
                size="large"
                onClick={() => {
                  router.replace("/dashboard");
                  router.refresh();
                }}
              >
                进入系统
              </Button>
            </>
          )}
        </section>
      </Card>
    </main>
  );
}
