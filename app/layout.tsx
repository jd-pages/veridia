import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import {
  Inter,
  Manrope,
  Noto_Sans_SC,
  Noto_Serif_SC,
} from "next/font/google";
import "antd/dist/reset.css";
import "./globals.css";
import AppLocaleProvider from "@/components/AppLocaleProvider";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
  fallback: ["Inter", "Arial", "sans-serif"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
  fallback: ["Arial", "sans-serif"],
});

const notoSansSC = Noto_Sans_SC({
  variable: "--font-noto-sans-sc",
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
  preload: false,
  fallback: ["PingFang SC", "Microsoft YaHei", "sans-serif"],
});

const notoSerifSC = Noto_Serif_SC({
  variable: "--font-noto-serif-sc",
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
  preload: false,
  fallback: ["Source Han Serif SC", "SimSun", "serif"],
});

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
      <body
        className={`${inter.variable} ${manrope.variable} ${notoSansSC.variable} ${notoSerifSC.variable}`}
      >
        <AntdRegistry>
          <AppLocaleProvider>{children}</AppLocaleProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
