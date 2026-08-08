import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/manrope/wght.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "@fontsource-variable/noto-serif-sc/wght.css";
import "antd/dist/reset.css";
import "./globals.css";
import AppLocaleProvider from "@/components/AppLocaleProvider";

export const metadata: Metadata = {
  title: "VERIDIA",
  description: "公司内部运营使用的多产品小红书笔记合规审核平台",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <AppLocaleProvider>{children}</AppLocaleProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
