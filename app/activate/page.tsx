"use client";

import "@ant-design/v5-patch-for-react-19";
import { App, Button, Card, ConfigProvider, Space } from "antd";
import { veridiaZhCN } from "@/components/AppLocaleProvider";
import { useRouter } from "next/navigation";
import AccountActivationForm from "@/components/AccountActivationForm";
import VeridiaLogo from "@/components/VeridiaLogo";

export default function ActivatePage() {
  const router = useRouter();
  return (
    <ConfigProvider locale={veridiaZhCN}>
      <App>
        <main className="setup-page">
          <Card className="setup-card" style={{ maxWidth: 720 }}>
            <div className="setup-brand">
              <VeridiaLogo theme="light" size={46} />
              <div>
                <strong>VERIDIA</strong>
                <span>CONTENT GOVERNANCE</span>
              </div>
            </div>
            <AccountActivationForm />
            <Space style={{ marginTop: 20 }}>
              <Button onClick={() => router.push("/login")}>
                返回登录
              </Button>
            </Space>
          </Card>
        </main>
      </App>
    </ConfigProvider>
  );
}
