"use client";

import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import updateLocale from "dayjs/plugin/updateLocale";

dayjs.extend(updateLocale);
dayjs.locale("zh-cn");
dayjs.updateLocale("zh-cn", { weekStart: 0 });

export const veridiaZhCN = {
  ...zhCN,
  DatePicker: zhCN.DatePicker
    ? {
        ...zhCN.DatePicker,
        lang: {
          ...zhCN.DatePicker.lang,
          monthFormat: "MMMM",
        },
      }
    : undefined,
  Calendar: zhCN.Calendar
    ? {
        ...zhCN.Calendar,
        lang: {
          ...zhCN.Calendar.lang,
          monthFormat: "MMMM",
        },
      }
    : undefined,
};

export default function AppLocaleProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ConfigProvider locale={veridiaZhCN}>{children}</ConfigProvider>;
}
