export const RULE_SYNC_STATUS_LABELS: Record<string, string> = {
  UP_TO_DATE: "已是最新",
  UPDATE_AVAILABLE: "发现新版本",
  DOWNLOADING: "正在下载",
  VERIFYING: "正在校验",
  APPLYING: "正在应用",
  COMPLETED: "同步完成",
  FAILED: "同步失败",
  USING_BUILTIN: "使用内置规则",
  RESTORED: "已恢复上一版",
};

export function ruleSyncStatusLabel(status: string | null | undefined) {
  if (!status) return "读取中";
  return RULE_SYNC_STATUS_LABELS[status] || status;
}
