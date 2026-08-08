import { formatShanghaiDateTime } from "@/lib/platform-published-at";

export const contentChannels = ["XIAOHONGSHU", "DOUYIN"] as const;
export const commercePlatforms = [
  "JD",
  "DOUYIN_ECOMMERCE",
  "TMALL",
  "TAOBAO",
] as const;

export type ContentChannel = (typeof contentChannels)[number];
export type CommercePlatform = (typeof commercePlatforms)[number];
/** @deprecated 旧 platform 字段实际保存的是内容渠道。 */
export type ResultPlatform = ContentChannel;

export interface ResultSourceMetadata {
  channel: ContentChannel | null;
  commercePlatform: CommercePlatform | null;
  storeName: string | null;
  orderNumber: string | null;
}

export const contentChannelLabels: Record<ContentChannel, string> = {
  XIAOHONGSHU: "小红书",
  DOUYIN: "抖音",
};

export const commercePlatformLabels: Record<CommercePlatform, string> = {
  JD: "京东",
  DOUYIN_ECOMMERCE: "抖音电商",
  TMALL: "天猫",
  TAOBAO: "淘宝",
};

export function parseContentChannel(value: unknown): ContentChannel | null {
  const normalized = String(value ?? "").trim().toLocaleUpperCase();
  if (
    normalized === "XIAOHONGSHU" ||
    normalized === "小红书" ||
    normalized === "XHS"
  ) {
    return "XIAOHONGSHU";
  }
  if (normalized === "DOUYIN" || normalized === "抖音") return "DOUYIN";
  return null;
}

export function parseCommercePlatform(
  value: unknown,
): CommercePlatform | null {
  const normalized = String(value ?? "").trim().toLocaleUpperCase();
  if (normalized === "JD" || normalized === "京东") return "JD";
  if (
    normalized === "DOUYIN_ECOMMERCE" ||
    normalized === "抖音电商" ||
    normalized === "抖音"
  ) {
    return "DOUYIN_ECOMMERCE";
  }
  if (normalized === "TMALL" || normalized === "天猫") return "TMALL";
  if (normalized === "TAOBAO" || normalized === "淘宝") return "TAOBAO";
  return null;
}

export function resolveTaskChannel(input: {
  channel?: unknown;
  platform?: unknown;
}) {
  return parseContentChannel(input.channel) || parseContentChannel(input.platform);
}

export function contentChannelLabel(value: unknown) {
  const channel = parseContentChannel(value);
  return channel ? contentChannelLabels[channel] : "—";
}

export function commercePlatformLabel(value: unknown) {
  const platform = parseCommercePlatform(value);
  return platform ? commercePlatformLabels[platform] : "—";
}

/** @deprecated 兼容仍引用旧命名的代码与历史测试。 */
export const parseResultPlatform = parseContentChannel;
/** @deprecated 兼容仍引用旧命名的代码与历史测试。 */
export const resultPlatformLabel = contentChannelLabel;
/** @deprecated 兼容仍引用旧命名的代码与历史测试。 */
export const resultPlatformLabels = contentChannelLabels;

export function cleanSourceField(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function formatAuditTime(value: unknown) {
  return formatShanghaiDateTime(value);
}
