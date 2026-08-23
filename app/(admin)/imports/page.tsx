"use client";

import type { Key } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, Card, Empty, Space, Table, Tag, Typography } from "antd";
import PageHeader from "@/components/PageHeader";
import StatusTag from "@/components/StatusTag";
import { apiFetch } from "@/lib/client";
import type { SessionUser } from "@/lib/auth";
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
  deletionResultCount: number;
  batchCount: number;
  creatorDisplayName: string | null;
  activityNames: string[];
}

const IMPORT_PAGE_SIZE = 12;

export default function ImportsPage() {
  const { message, modal } = App.useApp();
  const [items, setItems] = useState<ImportRecord[]>([]);
  const [currentRole, setCurrentRole] = useState<SessionUser["role"] | null>(
    null,
  );
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [records, user] = await Promise.all([
        apiFetch<ImportRecord[]>("/api/imports"),
        apiFetch<SessionUser | null>("/api/auth/me"),
      ]);
      setItems(records);
      setCurrentRole(user?.role || null);
      setCurrentPage((page) =>
        Math.min(
          page,
          Math.max(1, Math.ceil(records.length / IMPORT_PAGE_SIZE)),
        ),
      );
      setSelectedRowKeys((keys) =>
        keys.filter((key) => records.some((record) => record.id === key)),
      );
    } catch (error) {
      message.error(error instanceof Error ? error.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedItems = useMemo(
    () => items.filter((item) => selectedRowKeys.includes(item.id)),
    [items, selectedRowKeys],
  );

  const confirmDeletion = (
    records: ImportRecord[],
    mode: "SINGLE" | "BULK",
  ) => {
    const isBulk = mode === "BULK";
    const taskCount = records.reduce((sum, record) => sum + record.taskCount, 0);
    const resultCount = records.reduce(
      (sum, record) => sum + record.deletionResultCount,
      0,
    );
    const batchCount = records.reduce(
      (sum, record) => sum + record.batchCount,
      0,
    );
    modal.confirm({
      title: isBulk
        ? `确认批量删除 ${records.length} 条导入记录？`
        : "确认删除导入记录？",
      width: 560,
      okText: "确认删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      content: (
        <Space direction="vertical" size={6} style={{ width: "100%" }}>
          {!isBulk ? (
            <>
              <Typography.Text>文件：{records[0].fileName}</Typography.Text>
              <Typography.Text>
                活动：{records[0].activityNames.join("、") || "-"}
              </Typography.Text>
              <Typography.Text>
                导入时间：{new Date(records[0].createdAt).toLocaleString("zh-CN")}
              </Typography.Text>
            </>
          ) : (
            <Typography.Text>
              文件：{records.slice(0, 4).map(({ fileName }) => fileName).join("、")}
              {records.length > 4 ? ` 等 ${records.length} 个` : ""}
            </Typography.Text>
          )}
          <Typography.Text>
            将联动删除批次 {batchCount} 个、审核任务 {taskCount} 条、审核结果（含历史版本） {resultCount} 条。
          </Typography.Text>
          <Typography.Text>
            删除完成后，将同步释放仅由这些审核结果产生的重复审核占用。
          </Typography.Text>
          <Typography.Text type="danger" strong>
            此操作不可撤销。若任一所选记录仍有任务正在执行，本次删除将全部阻断且不删除任何数据。
          </Typography.Text>
        </Space>
      ),
      onOk: async () => {
        setDeleting(true);
        try {
          if (mode === "SINGLE") {
            await apiFetch(`/api/imports/${encodeURIComponent(records[0].id)}`, {
              method: "DELETE",
            });
          } else {
            await apiFetch("/api/imports/batch-delete", {
              method: "POST",
              body: JSON.stringify({ ids: records.map(({ id }) => id) }),
            });
          }
          message.success(
            records.length === 1
              ? isBulk
                ? "1 条导入记录及其业务数据已全部删除"
                : "导入记录及其业务数据已删除"
              : `${records.length} 条导入记录及其业务数据已全部删除`,
          );
          setSelectedRowKeys([]);
          await load();
        } catch (error) {
          message.error(error instanceof Error ? error.message : "删除失败");
          throw error;
        } finally {
          setDeleting(false);
        }
      },
    });
  };

  return (
    <>
      <PageHeader title="导入记录" description="追踪 Excel 预检与批量写入结果" />
      <Card className="surface-card">
        {currentRole === "ADMIN" && items.length ? (
          <Space style={{ marginBottom: 16 }}>
            <Button
              danger
              disabled={!selectedItems.length}
              loading={deleting}
              onClick={() => confirmDeletion(selectedItems, "BULK")}
            >
              批量删除{selectedItems.length ? `（${selectedItems.length}）` : ""}
            </Button>
            <Typography.Text type="secondary">
              仅可删除没有活动执行者的导入记录
            </Typography.Text>
          </Space>
        ) : null}
        {items.length ? (
          <Table<ImportRecord>
            rowKey="id"
            dataSource={items}
            loading={loading}
            rowSelection={
              currentRole === "ADMIN"
                ? {
                    selectedRowKeys,
                    onChange: setSelectedRowKeys,
                  }
                : undefined
            }
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
                width: 220,
                render: (_, row) => (
                  <Space>
                    {row.importType === "AUDIT_TASK" &&
                    row.status === "COMPLETED" &&
                    row.taskCount > 0 ? (
                      <Button
                        type="link"
                        href={`/results?importRecordId=${encodeURIComponent(row.id)}`}
                      >
                        查看审核结果
                      </Button>
                    ) : null}
                    {currentRole === "ADMIN" ? (
                      <Button
                        type="link"
                        danger
                        disabled={deleting}
                        onClick={() => confirmDeletion([row], "SINGLE")}
                      >
                        删除
                      </Button>
                    ) : null}
                  </Space>
                ),
              },
            ]}
            pagination={{
              pageSize: IMPORT_PAGE_SIZE,
              current: currentPage,
              onChange: setCurrentPage,
            }}
          />
        ) : (
          <Empty description="尚无 Excel 导入记录" />
        )}
      </Card>
    </>
  );
}
