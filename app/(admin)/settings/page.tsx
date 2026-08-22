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
import AccountSecurityPanel from "@/components/AccountSecurityPanel";
import { apiFetch } from "@/lib/client";
import { ruleSyncStatusLabel } from "@/lib/rules/labels";
import { settingLabel } from "@/lib/zh-CN";
import type { SessionUser } from "@/lib/auth";
import { canAccessSystemSettings } from "@/lib/permissions";

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
  templateVersion: string | null;
  templateSchemaVersion: number | null;
  source: string;
  status: string;
  counts: {
    products: number;
    activities: number;
    stageGroups: number;
    topicRules: number;
    storeTopicRules: number;
    storeAliases: number;
  };
  lastCheckedAt: string | null;
  lastSyncedAt: string | null;
}

interface XhsSessionDiagnostics {
  status: string;
  sessionState: string;
  profilePath: string;
  partition: string;
  browserRunning: boolean;
  controlState: string;
  controlReady: boolean;
  controlLastError: string | null;
  pageCount: number;
  lastCheckedAt: string | null;
  lastVerificationAt: string | null;
  lastInvalidReason: string | null;
  profileLocked: boolean;
  currentAuditTaskId: string | null;
  auditLock: {
    batchId: string;
    status: string;
    heartbeatAt: string;
    profilePath: string;
  } | null;
  browserInstanceCount?: number;
  interactivePageOpen?: boolean;
}

const xhsSessionStateLabels: Record<string, string> = {
  LOGGED_IN: "已登录",
  LOGGED_OUT: "未登录",
  SECURITY_RESTRICTED: "需要人工安全验证",
  SESSION_CHECKING: "正在检测",
  NETWORK_ERROR: "网络异常",
  UNKNOWN: "尚未确认",
};

const pacingFields = [
  ["XHS_AUDIT_WAIT_MIN_MS", "单篇后最短等待（毫秒）"],
  ["XHS_AUDIT_WAIT_MAX_MS", "单篇后最长等待（毫秒）"],
  ["XHS_NETWORK_MAX_RETRIES", "网络异常最大重试次数"],
  ["XHS_NETWORK_RETRY_FIRST_MS", "第一次重试等待（毫秒）"],
  ["XHS_NETWORK_RETRY_SECOND_MS", "第二次重试等待（毫秒）"],
  ["XHS_COOLDOWN_TASK_COUNT", "连续审核冷却篇数"],
  ["XHS_COOLDOWN_MS", "连续审核冷却时间（毫秒）"],
] as const;
const douyinPacingFields = [
  ["DOUYIN_AUDIT_WAIT_MIN_MS", "单篇后最短等待（毫秒）"],
  ["DOUYIN_AUDIT_WAIT_MAX_MS", "单篇后最长等待（毫秒）"],
  ["DOUYIN_NETWORK_MAX_RETRIES", "网络异常最大重试次数"],
  ["DOUYIN_NETWORK_RETRY_FIRST_MS", "第一次重试等待（毫秒）"],
  ["DOUYIN_NETWORK_RETRY_SECOND_MS", "第二次重试等待（毫秒）"],
  ["DOUYIN_COOLDOWN_TASK_COUNT", "连续审核冷却篇数"],
  ["DOUYIN_COOLDOWN_MS", "连续审核冷却时间（毫秒）"],
] as const;

export default function SettingsPage() {
  const { message, modal } = App.useApp();
  const desktopAvailable =
    typeof window !== "undefined" && Boolean(window.veridiaDesktop);
  const [items, setItems] = useState<Setting[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [ruleSync, setRuleSync] = useState<RuleSyncStatus | null>(null);
  const [xhsSession, setXhsSession] = useState<XhsSessionDiagnostics | null>(null);
  const [xhsBusy, setXhsBusy] = useState(false);
  const [douyinSession, setDouyinSession] = useState<XhsSessionDiagnostics | null>(null);
  const [douyinBusy, setDouyinBusy] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [syncingRules, setSyncingRules] = useState(false);
  const [migratingData, setMigratingData] = useState(false);
  const [currentRole, setCurrentRole] = useState<SessionUser["role"] | null>(
    null,
  );
  const canManageSystem = canAccessSystemSettings(currentRole);
  const load = useCallback(async () => {
    try {
      const allSettings = await apiFetch<Setting[]>("/api/settings");
      const data = allSettings.filter(
        (item) =>
          ![
            "AI_ENABLED",
            "AUTH_MODE",
            "DEFAULT_MIN_IMAGES",
            "SETUP_COMPLETED",
          ].includes(item.key) &&
          !item.key.startsWith("OPENAI_") &&
          !item.key.startsWith("XHS_") && !item.key.startsWith("DOUYIN_"),
      );
      setItems(data);
      setDrafts(
        Object.fromEntries(allSettings.map((item) => [item.key, item.value])),
      );
    } catch (error) {
      message.error(error instanceof Error ? error.message : "加载设置失败");
    }
  }, [message]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void apiFetch<SessionUser | null>("/api/auth/me").then((user) =>
      setCurrentRole(user?.role || null),
    );
  }, []);
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
  const loadXhsSession = useCallback(async () => {
    try {
      setXhsSession(
        await apiFetch<XhsSessionDiagnostics>("/api/automation/session"),
      );
    } catch (error) {
      message.error(error instanceof Error ? error.message : "读取小红书会话失败");
    }
  }, [message]);
  useEffect(() => { void loadXhsSession(); }, [loadXhsSession]);
  const loadDouyinSession = useCallback(async () => {
    try {
      setDouyinSession(await apiFetch<XhsSessionDiagnostics>("/api/automation/session?platform=DOUYIN"));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "读取抖音会话失败");
    }
  }, [message]);
  useEffect(() => { void loadDouyinSession(); }, [loadDouyinSession]);

  const runXhsAction = async (
    action:
      | "START_LOGIN"
      | "COMPLETE_LOGIN"
      | "CHECK_SESSION"
      | "RESTART_BROWSER"
      | "LOGOUT_XHS",
  ) => {
    setXhsBusy(true);
    try {
      setXhsSession(
        await apiFetch<XhsSessionDiagnostics>("/api/automation/session", {
          method: "POST",
          body: JSON.stringify({ action }),
        }),
      );
    } finally {
      setXhsBusy(false);
    }
  };

  const runDouyinAction = async (action: "START_LOGIN" | "COMPLETE_LOGIN" | "CHECK_SESSION" | "RESTART_BROWSER" | "LOGOUT_SESSION") => {
    setDouyinBusy(true);
    try {
      setDouyinSession(await apiFetch<XhsSessionDiagnostics>("/api/automation/session", {
        method: "POST",
        body: JSON.stringify({ platform: "DOUYIN", action }),
      }));
    } finally { setDouyinBusy(false); }
  };

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
      <AccountSecurityPanel />
      <Card
        className="surface-card"
        title="小红书会话诊断"
        style={{ marginBottom: 16 }}
      >
        <Descriptions column={{ xs: 1, md: 2, xl: 4 }}>
          <Descriptions.Item label="当前会话状态">
            <Tag>{xhsSessionStateLabels[xhsSession?.sessionState || "UNKNOWN"]}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="浏览器运行">
            {xhsSession?.browserRunning ? "是" : "否"}
          </Descriptions.Item>
          <Descriptions.Item label="浏览器控制状态">
            <Tag color={xhsSession?.controlReady ? "green" : "orange"}>
              {xhsSession?.controlReady ? "控制连接正常" : "需要重新启动"}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="当前页面数量">
            {xhsSession?.pageCount ?? 0}
          </Descriptions.Item>
          <Descriptions.Item label="Profile lock">
            {xhsSession?.profileLocked ? "已检测到" : "未检测到"}
          </Descriptions.Item>
          <Descriptions.Item label="Profile 路径">
            <span style={{ wordBreak: "break-all" }}>{xhsSession?.profilePath || "—"}</span>
          </Descriptions.Item>
          <Descriptions.Item label="持久会话类型">
            {xhsSession?.partition || "—"}
          </Descriptions.Item>
          <Descriptions.Item label="最近登录检测">
            {xhsSession?.lastCheckedAt
              ? new Date(xhsSession.lastCheckedAt).toLocaleString("zh-CN")
              : "尚未检测"}
          </Descriptions.Item>
          <Descriptions.Item label="最近安全验证">
            {xhsSession?.lastVerificationAt
              ? new Date(xhsSession.lastVerificationAt).toLocaleString("zh-CN")
              : "无"}
          </Descriptions.Item>
          <Descriptions.Item label="当前审核任务 ID">
            {xhsSession?.currentAuditTaskId || "无"}
          </Descriptions.Item>
          <Descriptions.Item label="当前审核批次">
            {xhsSession?.auditLock?.batchId || "无"}
          </Descriptions.Item>
          <Descriptions.Item label="最近失效原因">
            {xhsSession?.controlLastError || xhsSession?.lastInvalidReason || "无"}
          </Descriptions.Item>
        </Descriptions>
        <Space wrap>
          <Button loading={xhsBusy} onClick={() => void runXhsAction("START_LOGIN")}>
            打开小红书浏览器
          </Button>
          <Button loading={xhsBusy} onClick={() => void runXhsAction("COMPLETE_LOGIN")}>
            我已完成登录/验证
          </Button>
          <Button loading={xhsBusy} onClick={() => void runXhsAction("CHECK_SESSION")}>
            重新检测登录状态
          </Button>
          <Button loading={xhsBusy} onClick={() => void runXhsAction("RESTART_BROWSER")}>
            重启专用浏览器
          </Button>
          <Button
            danger
            loading={xhsBusy}
            onClick={() =>
              modal.confirm({
                title: "主动退出小红书登录？",
                content: "此操作会清除小红书专用 Profile 中的登录状态。",
                onOk: () => runXhsAction("LOGOUT_XHS"),
              })
            }
          >
            主动退出小红书登录
          </Button>
        </Space>
      </Card>
      <Card className="surface-card" title="抖音会话诊断" style={{ marginBottom: 16 }}>
        <Descriptions column={{ xs: 1, md: 2, xl: 4 }}>
          <Descriptions.Item label="当前会话状态"><Tag>{xhsSessionStateLabels[douyinSession?.sessionState || "UNKNOWN"]}</Tag></Descriptions.Item>
          <Descriptions.Item label="浏览器实例">{douyinSession?.browserInstanceCount ?? 0}</Descriptions.Item>
          <Descriptions.Item label="当前页面数量">{douyinSession?.pageCount ?? 0}</Descriptions.Item>
          <Descriptions.Item label="控制状态"><Tag color={douyinSession?.controlReady ? "green" : "orange"}>{douyinSession?.controlReady ? "控制连接正常" : "尚未启动或需重启"}</Tag></Descriptions.Item>
          <Descriptions.Item label="Profile 路径" span={2}><span style={{ wordBreak: "break-all" }}>{douyinSession?.profilePath || "—"}</span></Descriptions.Item>
          <Descriptions.Item label="当前审核批次">{douyinSession?.auditLock?.batchId || "无"}</Descriptions.Item>
          <Descriptions.Item label="人工交互页">{douyinSession?.interactivePageOpen ? "已打开" : "未打开"}</Descriptions.Item>
        </Descriptions>
        <Space wrap>
          <Button loading={douyinBusy} onClick={() => void runDouyinAction("START_LOGIN")}>打开抖音浏览器</Button>
          <Button loading={douyinBusy} onClick={() => void runDouyinAction("COMPLETE_LOGIN")}>我已完成登录/验证</Button>
          <Button loading={douyinBusy} onClick={() => void runDouyinAction("CHECK_SESSION")}>重新检测登录状态</Button>
          <Button loading={douyinBusy} onClick={() => void runDouyinAction("RESTART_BROWSER")}>重启抖音浏览器</Button>
          <Button danger loading={douyinBusy} onClick={() => void runDouyinAction("LOGOUT_SESSION")}>清除抖音登录状态</Button>
        </Space>
      </Card>
      <Card
        className="surface-card"
        title="小红书访问节奏"
        style={{ marginBottom: 16 }}
      >
        <Alert
          showIcon
          type="info"
          message="审核并发数固定为 1；安全验证不会自动重试，需人工完成后继续。"
          style={{ marginBottom: 12 }}
        />
        <Descriptions column={{ xs: 1, md: 2, xl: 4 }}>
          <Descriptions.Item label="审核并发数">1（固定）</Descriptions.Item>
          {pacingFields.map(([key, label]) => (
            <Descriptions.Item label={label} key={key}>
              <Input
                value={drafts[key] || ""}
                onChange={(event) =>
                  setDrafts((current) => ({ ...current, [key]: event.target.value }))
                }
              />
            </Descriptions.Item>
          ))}
        </Descriptions>
        <Button
          type="primary"
          disabled={!canManageSystem}
          onClick={async () => {
            await Promise.all(
              pacingFields.map(([key]) =>
                apiFetch("/api/settings", {
                  method: "PUT",
                  body: JSON.stringify({ key, value: drafts[key] }),
                }),
              ),
            );
            message.success("小红书访问节奏已保存");
            await load();
          }}
        >
          保存访问节奏
        </Button>
      </Card>
      <Card className="surface-card" title="抖音访问节奏" style={{ marginBottom: 16 }}>
        <Alert showIcon type="info" message="抖音与小红书使用独立 Profile、独立锁和独立节奏；审核并发数固定为 1。" style={{ marginBottom: 12 }} />
        <Descriptions column={{ xs: 1, md: 2, xl: 4 }}>
          <Descriptions.Item label="审核并发数">1（固定）</Descriptions.Item>
          {douyinPacingFields.map(([key, label]) => <Descriptions.Item label={label} key={key}><Input value={drafts[key] || ""} onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))} /></Descriptions.Item>)}
        </Descriptions>
        <Button type="primary" disabled={!canManageSystem} onClick={async () => {
          await Promise.all(douyinPacingFields.map(([key]) => apiFetch("/api/settings", { method: "PUT", body: JSON.stringify({ key, value: drafts[key] }) })));
          message.success("抖音访问节奏已保存");
          await load();
        }}>保存抖音访问节奏</Button>
      </Card>
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
          <Descriptions.Item label="自动检查更新" span={2}>
            <Switch
              checked={versionInfo?.autoUpdate || false}
              disabled={!desktopAvailable || !canManageSystem}
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
        </Descriptions>
        <Space>
          <Button
            icon={<FolderOpenOutlined />}
            loading={migratingData}
            disabled={!desktopAvailable || !canManageSystem}
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
          <Descriptions.Item label="表格模板版本">
            {ruleSync?.templateVersion || "内置默认模板"}
          </Descriptions.Item>
          <Descriptions.Item label="模板 Schema">
            {ruleSync?.templateSchemaVersion || 1}
          </Descriptions.Item>
          <Descriptions.Item label="同步来源">
            {ruleSync?.source === "GITHUB"
              ? "远程规则服务"
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
            {ruleSync?.counts.topicRules ?? 0} · 店铺规则{" "}
            {ruleSync?.counts.storeTopicRules ?? 0} · 导入别名{" "}
            {ruleSync?.counts.storeAliases ?? 0}
          </Descriptions.Item>
        </Descriptions>
        {!ruleSync?.configured && (
          <Alert
            showIcon
            type="info"
            style={{ marginBottom: 12 }}
            message="远程规则服务尚未配置，当前继续使用本地规则。"
          />
        )}
        <Space wrap>
          {canManageSystem && <Button
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
          </Button>}
          {canManageSystem && <Button
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
          </Button>}
          {canManageSystem && <Button
            onClick={async () => {
              const history = await apiFetch<
                Array<{
                  ruleVersion: string | null;
                  status: string;
                  errorCode: string | null;
                  message: string | null;
                  technicalMessage: string | null;
                  startedAt: string;
                }>
              >("/api/rule-sync/history");
              modal.info({
                title: "规则同步记录",
                width: 680,
                content: (
                  <Space direction="vertical" style={{ width: "100%" }}>
                    {history.length ? history.map((item, index) => (
                      <div key={`${item.startedAt}-${index}`}>
                        <div>
                          {new Date(item.startedAt).toLocaleString("zh-CN")} ·{" "}
                          {item.ruleVersion || "本地规则"} ·{" "}
                          {ruleSyncStatusLabel(item.status)}
                          {item.errorCode ? ` · ${item.errorCode}` : ""}
                        </div>
                        {item.message && <div>{item.message}</div>}
                        {item.technicalMessage && (
                          <div
                            style={{
                              color: "#66748a",
                              wordBreak: "break-all",
                            }}
                          >
                            技术原因：{item.technicalMessage}
                          </div>
                        )}
                      </div>
                    )) : <span>暂无同步记录</span>}
                  </Space>
                ),
              });
            }}
          >
            查看同步记录
          </Button>}
          {canManageSystem && <Button
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
          </Button>}
          {canManageSystem && <Button href="/api/rule-sync/export">导出当前规则</Button>}
        </Space>
      </Card>
      {canManageSystem && <Card className="surface-card">
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
      </Card>}
    </>
  );
}
