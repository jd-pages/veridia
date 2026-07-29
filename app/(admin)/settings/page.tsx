"use client";

import { useCallback, useEffect, useState } from "react";
import {
  App,
  Button,
  Card,
  Descriptions,
  Input,
  Space,
  Switch,
  Table,
  Tag,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import PageHeader from "@/components/PageHeader";
import { apiFetch } from "@/lib/client";
import { settingLabel } from "@/lib/zh-CN";

interface Setting {
  id: string;
  key: string;
  value: string;
  description: string | null;
  isSecret: boolean;
  updatedAt: string;
}

interface VersionInfo {
  version: string;
  buildDate: string | null;
  databaseVersion: string;
  dataDirectory: string;
  autoUpdate: boolean;
  packaged: boolean;
}

export default function SettingsPage() {
  const { message } = App.useApp();
  const desktopAvailable =
    typeof window !== "undefined" && Boolean(window.veridiaDesktop);
  const [items, setItems] = useState<Setting[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const load = useCallback(async () => {
    try {
      const data = (await apiFetch<Setting[]>("/api/settings")).filter(
        (item) => item.key !== "AI_ENABLED" && !item.key.startsWith("OPENAI_"),
      );
      setItems(data);
      setDrafts(Object.fromEntries(data.map((item) => [item.key, item.value])));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "加载设置失败");
    }
  }, [message]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const desktop = window.veridiaDesktop;
    const request = desktop
      ? desktop.getSystemInfo()
      : apiFetch<VersionInfo>("/api/system/version");
    request.then(setVersionInfo).catch(() => undefined);
  }, []);

  return (
    <>
      <PageHeader title="系统设置" description="本地固定规则审核参数" />
      <Card className="surface-card" title="软件与更新" style={{ marginBottom: 16 }}>
        <Descriptions column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label="当前版本">
            VERIDIA {versionInfo?.version || "—"}
          </Descriptions.Item>
          <Descriptions.Item label="构建日期">
            {versionInfo?.buildDate
              ? new Date(versionInfo.buildDate).toLocaleString("zh-CN")
              : "开发版本"}
          </Descriptions.Item>
          <Descriptions.Item label="数据库版本">
            {versionInfo?.databaseVersion || "—"}
          </Descriptions.Item>
          <Descriptions.Item label="数据保存位置">
            {versionInfo?.dataDirectory || "—"}
          </Descriptions.Item>
          <Descriptions.Item label="自动检查更新">
            <Switch
              checked={versionInfo?.autoUpdate || false}
              disabled={!desktopAvailable}
              checkedChildren="开启"
              unCheckedChildren="关闭"
              onChange={async (checked) => {
                await window.veridiaDesktop?.setAutoUpdate(checked);
                setVersionInfo((current) =>
                  current ? { ...current, autoUpdate: checked } : current,
                );
              }}
            />
          </Descriptions.Item>
          <Descriptions.Item label="更新日志">
            <Button
              type="link"
              disabled={!desktopAvailable}
              onClick={() => void window.veridiaDesktop?.openReleaseNotes()}
            >
              查看历史版本
            </Button>
          </Descriptions.Item>
        </Descriptions>
        <Space>
          <Button
            icon={<ReloadOutlined />}
            loading={checkingUpdate}
            disabled={!desktopAvailable}
            onClick={async () => {
              setCheckingUpdate(true);
              try {
                await window.veridiaDesktop?.checkForUpdates();
              } finally {
                setTimeout(() => setCheckingUpdate(false), 800);
              }
            }}
          >
            检查更新
          </Button>
          {!versionInfo?.packaged && (
            <Tag>浏览器开发模式不执行在线更新</Tag>
          )}
        </Space>
      </Card>
      <Card className="surface-card">
        <Table<Setting>
          rowKey="id"
          dataSource={items}
          pagination={false}
          columns={[
            {
              title: "设置项",
              dataIndex: "key",
              width: 240,
              render: (value) => <Tag>{settingLabel(value)}</Tag>,
            },
            { title: "说明", dataIndex: "description" },
            {
              title: "值",
              width: 280,
              render: (_value, row) =>
                row.isSecret ? (
                  <Input value="••••••••" disabled />
                ) : (
                  <Input value={drafts[row.key]} onChange={(event) => setDrafts((current) => ({ ...current, [row.key]: event.target.value }))} />
                ),
            },
            {
              title: "操作",
              width: 110,
              render: (_value, row) => (
                <Button
                  type="link"
                  disabled={row.isSecret}
                  onClick={async () => {
                    await apiFetch("/api/settings", {
                      method: "PUT",
                      body: JSON.stringify({ key: row.key, value: drafts[row.key] }),
                    });
                    message.success("设置已保存");
                    void load();
                  }}
                >
                  保存
                </Button>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}
