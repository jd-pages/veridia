"use client";

import "@ant-design/v5-patch-for-react-19";
import {
  App,
  Button,
  ConfigProvider,
  Layout,
  Menu,
  Space,
} from "antd";
import zhCN from "antd/locale/zh_CN";
import {
  AppstoreOutlined,
  AuditOutlined,
  BarChartOutlined,
  FileSearchOutlined,
  ImportOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ProductOutlined,
  SettingOutlined,
  TagsOutlined,
} from "@ant-design/icons";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { SessionUser } from "@/lib/auth";
import { apiFetch } from "@/lib/client";
import VeridiaLogo from "@/components/VeridiaLogo";
import DesktopUpdateCenter from "@/components/DesktopUpdateCenter";

const { Sider, Header, Content } = Layout;

interface RuleUpdateStatus {
  configured: boolean;
  status: string;
  currentVersion: string;
  latestVersion: string | null;
}

function RuleUpdateChecker() {
  const router = useRouter();
  const { notification } = App.useApp();

  useEffect(() => {
    // 每次启动后触发一次；服务端保证同一天自动检查最多一次。
    void apiFetch<RuleUpdateStatus>("/api/rule-sync/check", {
      method: "POST",
    })
      .then((status) => {
        if (
          status.configured &&
          status.status === "UPDATE_AVAILABLE" &&
          status.latestVersion
        ) {
          notification.info({
            key: "veridia-rule-update",
            message: `发现新规则 ${status.latestVersion}`,
            description: `当前使用 ${status.currentVersion}，可在系统设置中校验并同步新规则。`,
            duration: 0,
            btn: (
              <Button
                type="primary"
                size="small"
                onClick={() => router.push("/settings")}
              >
                查看规则更新
              </Button>
            ),
          });
        }
      })
      .catch(() => undefined);
  }, [notification, router]);

  return null;
}

const items = [
  { key: "/dashboard", icon: <BarChartOutlined />, label: "仪表盘", roles: ["ADMIN", "OPERATOR", "VIEWER"] },
  { key: "/tasks", icon: <AuditOutlined />, label: "审核任务", roles: ["ADMIN", "OPERATOR"] },
  { key: "/results", icon: <FileSearchOutlined />, label: "审核结果", roles: ["ADMIN", "OPERATOR", "VIEWER"] },
  { key: "/products", icon: <ProductOutlined />, label: "产品管理", roles: ["ADMIN"] },
  { key: "/campaigns", icon: <AppstoreOutlined />, label: "活动管理", roles: ["ADMIN"] },
  { key: "/rules", icon: <TagsOutlined />, label: "话题规则", roles: ["ADMIN"] },
  { key: "/imports", icon: <ImportOutlined />, label: "导入记录", roles: ["ADMIN", "OPERATOR"] },
  { key: "/settings", icon: <SettingOutlined />, label: "系统设置", roles: ["ADMIN"] },
];

export default function AdminShell({
  user,
  children,
}: {
  user: SessionUser;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const visibleItems = items.filter((item) => item.roles.includes(user.role));
  const selected =
    visibleItems.find((item) => pathname === item.key || pathname.startsWith(`${item.key}/`))
      ?.key || "/dashboard";

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 1100px)");
    const syncCollapsedState = (event: MediaQueryListEvent | MediaQueryList) => {
      setCollapsed(event.matches);
    };

    syncCollapsedState(mediaQuery);
    mediaQuery.addEventListener("change", syncCollapsedState);
    return () => mediaQuery.removeEventListener("change", syncCollapsedState);
  }, []);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#163c85",
          colorPrimaryHover: "#24539f",
          colorPrimaryActive: "#0f2e68",
          colorInfo: "#163c85",
          colorText: "#1c2738",
          colorTextSecondary: "#66748a",
          colorBorder: "#dfe5ee",
          colorBorderSecondary: "#e7ebf1",
          colorBgLayout: "#f4f7fb",
          borderRadius: 10,
          fontFamily:
            'var(--font-noto-sans-sc), "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
        },
        components: {
          Layout: { siderBg: "#18263d", headerBg: "#ffffff" },
          Menu: {
            darkItemBg: "#18263d",
            darkItemColor: "#b8c2d1",
            darkItemHoverBg: "rgba(255, 255, 255, 0.08)",
            darkItemHoverColor: "#f8fafc",
            darkItemSelectedBg: "#f4f6f8",
            darkItemSelectedColor: "#163c85",
            itemBorderRadius: 8,
            itemHeight: 44,
          },
          Button: {
            defaultBorderColor: "#d8dee8",
            defaultColor: "#334155",
          },
          Card: {
            colorBorderSecondary: "#e5eaf2",
          },
          Table: { headerBg: "#f7f9fc", headerColor: "#334155" },
        },
      }}
    >
      <App>
        <RuleUpdateChecker />
        <Layout
          className={`admin-shell${collapsed ? " admin-shell-collapsed" : ""}`}
        >
          <Sider
            className="admin-sider"
            width={224}
            collapsedWidth={72}
            collapsed={collapsed}
            trigger={null}
          >
            <div className="brand-lockup">
              <VeridiaLogo
                theme="dark"
                size={40}
                title="VERIDIA V-Core"
              />
              {!collapsed && (
                <div className="brand-wordmark">
                  <span>VERIDIA</span>
                  <small>CONTENT GOVERNANCE</small>
                </div>
              )}
            </div>
            <div className="admin-sider-scroll">
              <Menu
                className="admin-nav-menu"
                theme="dark"
                mode="inline"
                selectedKeys={[selected]}
                items={visibleItems.map((item) => ({
                  key: item.key,
                  icon: item.icon,
                  label: item.label,
                  className:
                    item.key === "/settings"
                      ? "admin-nav-settings-item"
                      : undefined,
                }))}
                onClick={({ key }) => router.push(key)}
              />
            </div>
          </Sider>
          <Layout className="admin-main">
            <Header className="admin-header">
              <Space size={12} className="admin-header-leading">
                <Button
                  className="sider-toggle"
                  type="text"
                  icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                  aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
                  title={collapsed ? "展开侧边栏" : "折叠侧边栏"}
                  onClick={() => setCollapsed((value) => !value)}
                />
                <span className="header-title">VERIDIA 工作台</span>
              </Space>
            </Header>
            <Content className="admin-content">{children}</Content>
            <DesktopUpdateCenter />
          </Layout>
        </Layout>
      </App>
    </ConfigProvider>
  );
}
