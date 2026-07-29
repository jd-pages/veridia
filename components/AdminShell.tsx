"use client";

import "@ant-design/v5-patch-for-react-19";
import {
  App,
  Avatar,
  Button,
  ConfigProvider,
  Dropdown,
  Layout,
  Menu,
  Space,
  Tag,
  Typography,
} from "antd";
import zhCN from "antd/locale/zh_CN";
import {
  AppstoreOutlined,
  AuditOutlined,
  BarChartOutlined,
  DownOutlined,
  FileSearchOutlined,
  ImportOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ProductOutlined,
  SettingOutlined,
  TagsOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { SessionUser } from "@/lib/auth";
import { apiFetch } from "@/lib/client";
import VeridiaLogo from "@/components/VeridiaLogo";
import { businessStatusLabel } from "@/lib/zh-CN";
import DesktopUpdateCenter from "@/components/DesktopUpdateCenter";

const { Sider, Header, Content } = Layout;

const items = [
  { key: "/dashboard", icon: <BarChartOutlined />, label: "仪表盘", roles: ["ADMIN", "OPERATOR", "VIEWER"] },
  { key: "/tasks", icon: <AuditOutlined />, label: "审核任务", roles: ["ADMIN", "OPERATOR"] },
  { key: "/results", icon: <FileSearchOutlined />, label: "审核结果", roles: ["ADMIN", "OPERATOR", "VIEWER"] },
  { key: "/products", icon: <ProductOutlined />, label: "产品管理", roles: ["ADMIN"] },
  { key: "/campaigns", icon: <AppstoreOutlined />, label: "活动管理", roles: ["ADMIN"] },
  { key: "/rules", icon: <TagsOutlined />, label: "话题规则", roles: ["ADMIN"] },
  { key: "/imports", icon: <ImportOutlined />, label: "导入记录", roles: ["ADMIN", "OPERATOR"] },
  { key: "/users", icon: <TeamOutlined />, label: "用户管理", roles: ["ADMIN"] },
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
          colorPrimary: "#b4232a",
          colorInfo: "#b4232a",
          borderRadius: 10,
          fontFamily:
            'var(--font-noto-sans-sc), "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
        },
        components: {
          Layout: { siderBg: "#192130", headerBg: "#ffffff" },
          Menu: {
            darkItemBg: "#192130",
            darkItemSelectedBg: "#b4232a",
            darkItemHoverBg: "#263043",
            itemBorderRadius: 8,
          },
          Table: { headerBg: "#f7f8fa", headerColor: "#344054" },
        },
      }}
    >
      <App>
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
                theme="dark"
                mode="inline"
                selectedKeys={[selected]}
                items={visibleItems.map((item) => ({
                  key: item.key,
                  icon: item.icon,
                  label: item.label,
                }))}
                onClick={({ key }) => router.push(key)}
                style={{ padding: "6px 10px", borderInlineEnd: 0 }}
              />
            </div>
          </Sider>
          <Layout className="admin-main">
            <Header className="admin-header">
              <Space size={12}>
                <Button
                  className="sider-toggle"
                  type="text"
                  icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                  aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
                  title={collapsed ? "展开侧边栏" : "折叠侧边栏"}
                  onClick={() => setCollapsed((value) => !value)}
                />
                <Space className="header-title">
                  <Typography.Text strong>运营审核工作台</Typography.Text>
                  <Tag color="red">本地环境</Tag>
                </Space>
              </Space>
              <Dropdown
                trigger={["click"]}
                menu={{
                  items: [
                    {
                      key: "logout",
                      icon: <LogoutOutlined />,
                      label: "退出登录",
                      onClick: async () => {
                        await apiFetch("/api/auth/logout", { method: "POST" });
                        router.replace("/login");
                        router.refresh();
                      },
                    },
                  ],
                }}
              >
                <Button type="text">
                  <Space>
                    <Avatar size="small" style={{ background: "#b4232a" }}>
                      {user.displayName.slice(0, 1)}
                    </Avatar>
                    <span>{user.displayName}</span>
                    <Typography.Text type="secondary">
                      {businessStatusLabel(user.role)}
                    </Typography.Text>
                    <DownOutlined />
                  </Space>
                </Button>
              </Dropdown>
            </Header>
            <Content className="admin-content">{children}</Content>
            <DesktopUpdateCenter />
          </Layout>
        </Layout>
      </App>
    </ConfigProvider>
  );
}
