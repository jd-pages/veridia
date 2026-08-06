"use client";

import { useEffect, useState } from "react";
import { App, Button, Card, Empty, Table, Tag } from "antd";
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
  taskCount: number;
  resultCount: number;
  batchCount: number;
  creatorDisplayName: string | null;
  activityNames: string[];
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
                title: "活动名称",
                dataIndex: "activityNames",
                width: 260,
                render: (values: string[]) => values?.join("、") || "-",
              },
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
                title: "审核进度",
                width: 180,
                render: (_, row) =>
                  row.importType === "AUDIT_TASK"
                    ? `结果 ${row.resultCount} 条 / 未完成 ${Math.max(row.taskCount - row.resultCount, 0)} 条`
                    : "-",
              },
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
              {
                title: "导入人",
                dataIndex: "creatorDisplayName",
                width: 120,
                render: (value: string | null) => value || "-",
              },
              {
                title: "操作",
                fixed: "right",
                width: 150,
                render: (_, row) =>
                  row.importType === "AUDIT_TASK" &&
                  row.status === "COMPLETED" &&
                  row.taskCount > 0 ? (
                    <Button
                      type="link"
                      href={`/results?importRecordId=${encodeURIComponent(row.id)}`}
                    >
                      查看审核结果
                    </Button>
                  ) : null,
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
