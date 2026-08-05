export const resultPlatforms = ["XIAOHONGSHU", "DOUYIN"] as const;

export type ResultPlatform = (typeof resultPlatforms)[number];

export interface ResultSourceMetadata {
  platform: ResultPlatform | null;
  storeName: string | null;
  orderNumber: string | null;
}

export const resultPlatformLabels: Record<ResultPlatform, string> = {
  XIAOHONGSHU: "小红书",
  DOUYIN: "抖音",
};

export function parseResultPlatform(value: unknown): ResultPlatform | null {
  const normalized = String(value ?? "").trim().toLocaleUpperCase();
  if (
    normalized === "XIAOHONGSHU" ||
    normalized === "小红书" ||
    normalized === "XHS"
  ) {
    return "XIAOHONGSHU";
  }
  if (normalized === "DOUYIN" || normalized === "抖音") {
    return "DOUYIN";
  }
  return null;
}

export function resultPlatformLabel(value: unknown) {
  const platform = parseResultPlatform(value);
  return platform ? resultPlatformLabels[platform] : "—";
}

export function cleanSourceField(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function formatAuditTime(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "—";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}月${day}日 ${hour}:${minute}`;
}
