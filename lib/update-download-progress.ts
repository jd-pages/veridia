const MEGABYTE = 1024 * 1024;

export function formatUpdateBytes(value?: number) {
  if (!Number.isFinite(value) || !value || value < 0) return "0 MB";
  return `${(value / MEGABYTE).toFixed(1)} MB`;
}

export function formatUpdateSpeed(value?: number) {
  if (!Number.isFinite(value) || !value || value <= 0) return "计算中";
  return `${(value / MEGABYTE).toFixed(1)} MB/s`;
}

export function estimateUpdateSeconds(
  transferred?: number,
  total?: number,
  bytesPerSecond?: number,
) {
  if (
    !Number.isFinite(transferred) ||
    !Number.isFinite(total) ||
    !Number.isFinite(bytesPerSecond) ||
    !bytesPerSecond ||
    bytesPerSecond <= 0 ||
    !total ||
    total <= 0
  ) {
    return null;
  }
  return Math.max(0, Math.ceil((total - (transferred || 0)) / bytesPerSecond));
}

export function updateModeLabel(
  mode?: "checking" | "differential" | "full",
) {
  if (mode === "differential") return "差分更新";
  if (mode === "full") return "完整更新（差分不可用，已自动回退）";
  return "正在确认差分更新";
}
