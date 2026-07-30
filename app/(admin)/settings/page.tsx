"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
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
import { FolderOpenOutlined, ReloadOutlined } from "@ant-design/icons";
import PageHeader from "@/components/PageHeader";
import { apiFetch } from "@/lib/client";
import { ruleSyncStatusLabel } from "@/lib/rules/labels";
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

interface RuleSyncStatus {
  configured: boolean;
  repository: string | null;
  currentVersion: string;
  latestVersion: string | null;
  schemaVersion: number;
  source: string;
  status: string;
  counts: {
    products: number;
    activities: number;
    stageGroups: number;
    topicRules: number;
  };
  lastCheckedAt: string | null;
  lastSyncedAt: string | null;
}

export default function SettingsPage() {
  const { message, modal } = App.useApp();
  const desktopAvailable =
    typeof window !== "undefined" && Boolean(window.veridiaDesktop);
  const [items, setItems] = useState<Setting[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [ruleSync, setRuleSync] = useState<RuleSyncStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [syncingRules, setSyncingRules] = useState(false);
  const [migratingData, setMigratingData] = useState(false);
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
  const loadRuleSync = useCallback(async () => {
    try {
      setRuleSync(await apiFetch<RuleSyncStatus>("/api/rule-sync/status"));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "读取规则同步状态失败");
    }
  }, [message]);
  useEffect(() => { void loadRuleSync(); }, [loadRuleSync]);

  const changeDataDirectory = async () => {
    const desktop = window.veridiaDesktop;
    if (!desktop) return;
    const selected = await desktop.chooseDataDirectory();
    if (!selected) return;
    if (!selected.success || !selected.dataDirectory) {
      message.error(selected.error || "所选目录不可用");
      return;
    }
    const targetDirectory = selected.dataDirectory;
    modal.confirm({
      title: "迁移 VERIDIA 数据",
      content: (
        <Space direction="vertical" size={8}>
          <span>后台服务将在迁移期间暂时停止。</span>
          <span>系统会先备份数据库，再迁移并校验全部数据。</span>
          <span style={{ wordBreak: "break-all" }}>
            新数据位置：{targetDirectory}
          </span>
        </Space>
      ),
      okText: "开始迁移",
      cancelText: "取消",
      onOk: async () => {
        setMigratingData(true);
        const result = await desktop.migrateDataDirectory(targetDirectory);
        if (!result.success) {
          setMigratingData(false);
          message.error(result.error || "数据迁移失败，原数据目录保持不变");
          return Promise.reject();
        }
        message.success("数据迁移校验完成，VERIDIA 正在重新启动");
      },
    });
  };

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
            icon={<FolderOpenOutlined />}
            loading={migratingData}
            disabled={!desktopAvailable}
            onClick={() => void changeDataDirectory()}
          >
            更改数据位置
          </Button>
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
      <Card
        className="surface-card"
        title="规则同步"
        style={{ marginBottom: 16 }}
      >
        <Descriptions column={{ xs: 1, md: 2, xl: 4 }}>
          <Descriptions.Item label="当前规则版本">
            {ruleSync?.currentVersion || "—"}
          </Descriptions.Item>
          <Descriptions.Item label="最新远程版本">
            {ruleSync?.latestVersion || "尚未检查"}
          </Descriptions.Item>
          <Descriptions.Item label="Schema 版本">
            {ruleSync?.schemaVersion || "—"}
          </Descriptions.Item>
          <Descriptions.Item label="同步来源">
            {ruleSync?.source === "GITHUB"
              ? "GitHub规则仓库"
              : ruleSync?.source === "RESTORE"
                ? "上一版备份"
                : "内置规则"}
          </Descriptions.Item>
          <Descriptions.Item label="同步状态">
            <Tag>{ruleSyncStatusLabel(ruleSync?.status)}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="最近检查">
            {ruleSync?.lastCheckedAt
              ? new Date(ruleSync.lastCheckedAt).toLocaleString("zh-CN")
              : "尚未检查"}
          </Descriptions.Item>
          <Descriptions.Item label="最近同步">
            {ruleSync?.lastSyncedAt
              ? new Date(ruleSync.lastSyncedAt).toLocaleString("zh-CN")
              : "使用内置规则"}
          </Descriptions.Item>
          <Descriptions.Item label="当前规则数量">
            产品 {ruleSync?.counts.products ?? 0} · 活动{" "}
            {ruleSync?.counts.activities ?? 0} · 阶段组{" "}
            {ruleSync?.counts.stageGroups ?? 0} · 话题{" "}
            {ruleSync?.counts.topicRules ?? 0}
          </Descriptions.Item>
        </Descriptions>
        {!ruleSync?.configured && (
          <Alert
            showIcon
            type="info"
            style={{ marginBottom: 12 }}
            message="独立 GitHub 规则仓库尚未配置，当前继续使用本地规则。"
          />
        )}
        <Space wrap>
          <Button
            disabled={!ruleSync?.configured}
            onClick={async () => {
              setSyncingRules(true);
              try {
                const next = await apiFetch<RuleSyncStatus>(
                  "/api/rule-sync/check?force=true",
                  { method: "POST" },
                );
                setRuleSync(next);
                message.success(
                  next.status === "UPDATE_AVAILABLE"
                    ? "发现新的规则版本"
                    : "当前规则已是最新",
                );
              } finally {
                setSyncingRules(false);
              }
            }}
          >
            检查更新
          </Button>
          <Button
            type="primary"
            loading={syncingRules}
            disabled={!ruleSync?.configured}
            onClick={async () => {
              setSyncingRules(true);
              try {
                setRuleSync(
                  await apiFetch<RuleSyncStatus>("/api/rule-sync/apply", {
                    method: "POST",
                  }),
                );
                message.success("规则同步完成");
              } catch (error) {
                message.warning(
                  error instanceof Error
                    ? error.message
                    : "暂时无法获取最新规则，已继续使用本地规则。",
                );
                await loadRuleSync();
              } finally {
                setSyncingRules(false);
              }
            }}
          >
            立即同步
          </Button>
          <Button
            onClick={async () => {
              const history = await apiFetch<
                Array<{
                  ruleVersion: string | null;
                  status: string;
                  message: string | null;
                  createdAt: string;
                }>
              >("/api/rule-sync/history");
              modal.info({
                title: "规则同步记录",
                width: 680,
                content: (
                  <Space direction="vertical" style={{ width: "100%" }}>
                    {history.length ? history.map((item, index) => (
                      <div key={`${item.createdAt}-${index}`}>
                        {new Date(item.createdAt).toLocaleString("zh-CN")} ·{" "}
                        {item.ruleVersion || "本地规则"} ·{" "}
                        {ruleSyncStatusLabel(item.status)}
                        {item.message ? ` · ${item.message}` : ""}
                      </div>
                    )) : <span>暂无同步记录</span>}
                  </Space>
                ),
              });
            }}
          >
            查看同步记录
          </Button>
          <Button
            onClick={async () => {
              setRuleSync(
                await apiFetch<RuleSyncStatus>("/api/rule-sync/restore", {
                  method: "POST",
                }),
              );
              message.success("已恢复上一版规则");
            }}
          >
            恢复上一版规则
          </Button>
          <Button href="/api/rule-sync/export">导出当前规则</Button>
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
