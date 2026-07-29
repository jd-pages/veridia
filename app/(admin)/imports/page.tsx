"use client";

import { useEffect, useState } from "react";
import { App, Card, Empty, Table, Tag } from "antd";
import PageHeader from "@/components/PageHeader";
import StatusTag from "@/components/StatusTag";
import { apiFetch } from "@/lib/client";
import { businessImportTypeLabel } from "@/lib/zh-CN";

interface ImportRecord {
  id: string;
  fileName: string;
  importType: string;
  totalCount: number;
  validCount: number;
  invalidCount: number;
  skippedCount: number;
  status: string;
  summary: string;
  createdAt: string;
}

export default function ImportsPage() {
  const { message } = App.useApp();
  const [items, setItems] = useState<ImportRecord[]>([]);
  useEffect(() => {
    apiFetch<ImportRecord[]>("/api/imports").then(setItems).catch((error) =>
      message.error(error instanceof Error ? error.message : "加载失败"),
    );
  }, [message]);

  return (
    <>
      <PageHeader title="导入记录" description="追踪 Excel 预检与批量写入结果" />
      <Card className="surface-card">
        {items.length ? (
          <Table<ImportRecord>
            rowKey="id"
            dataSource={items}
            columns={[
              { title: "文件名", dataIndex: "fileName", width: 280 },
              {
                title: "导入类型",
                dataIndex: "importType",
                width: 140,
                render: (value) => <Tag>{businessImportTypeLabel(value)}</Tag>,
              },
              { title: "总行数", dataIndex: "totalCount", width: 100 },
              { title: "有效", dataIndex: "validCount", width: 90 },
              { title: "异常", dataIndex: "invalidCount", width: 90 },
              { title: "跳过", dataIndex: "skippedCount", width: 90 },
              {
                title: "状态",
                dataIndex: "status",
                width: 120,
                render: (value) => <StatusTag value={value} />,
              },
              {
                title: "导入时间",
                dataIndex: "createdAt",
                width: 180,
                render: (value: string) => new Date(value).toLocaleString("zh-CN"),
              },
            ]}
            pagination={{ pageSize: 12 }}
          />
        ) : (
          <Empty description="尚无 Excel 导入记录" />
        )}
      </Card>
    </>
  );
}
