import type { ExtractedNote } from "@/lib/types";

export interface ExtractorAdapter {
  name: string;
  version: string;
  canHandle(url: string): boolean;
  extract(source: unknown): Promise<ExtractedNote>;
}

export class MockExtractorAdapter implements ExtractorAdapter {
  name = "mock-xhs";
  version = "1.0.0";

  canHandle(url: string) {
    return url.includes("/mock/xhs") || url.includes("localhost");
  }

  async extract(source: unknown): Promise<ExtractedNote> {
    const payload = source as ExtractedNote;
    return {
      ...payload,
      adapterName: this.name,
      adapterVersion: this.version,
      extractedAt: payload.extractedAt || new Date().toISOString(),
    };
  }
}

export function assertExtractorPayload(input: unknown): asserts input is ExtractedNote {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("提取数据格式无效");
  const payload = input as Partial<ExtractedNote>;
  if (typeof payload.url !== "string" || !payload.url.trim() || !Array.isArray(payload.topics)) {
    throw new Error("提取数据缺少必要字段");
  }
  if (
    typeof payload.adapterName !== "string" || !payload.adapterName.trim() ||
    typeof payload.adapterVersion !== "string" || !payload.adapterVersion.trim() ||
    typeof payload.extractedAt !== "string" || !Number.isFinite(Date.parse(payload.extractedAt)) ||
    !["NORMAL", "NOTE_NOT_FOUND", "NO_PERMISSION", "LOGIN_EXPIRED", "SECURITY_VERIFICATION", "READ_FAILED", "NEEDS_CONFIRMATION"].includes(payload.pageStatus || "")
  ) throw new Error("提取数据缺少有效适配器、采集时间或页面状态");
  for (const key of ["finalUrl", "noteId", "platformNoteId", "contentId"] as const) {
    if (payload[key] != null && typeof payload[key] !== "string") {
      throw new Error("提取作品身份字段格式无效");
    }
  }
  if (payload.contentChannel != null && !["XIAOHONGSHU", "DOUYIN"].includes(payload.contentChannel)) {
    throw new Error("提取内容平台无效");
  }
  for (const topics of [payload.topics, payload.verifiedPlatformTopics, payload.verifiedDouyinTopics]) {
    if (topics == null) continue;
    if (!Array.isArray(topics) || topics.some((topic) =>
      !topic || typeof topic.displayText !== "string" ||
      typeof topic.isLinkElement !== "boolean" || typeof topic.hasHref !== "boolean" ||
      typeof topic.styleFeature !== "boolean"
    )) throw new Error("提取话题字段格式无效");
  }
}
