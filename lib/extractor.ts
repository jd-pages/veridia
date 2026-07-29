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
  if (!input || typeof input !== "object") throw new Error("提取数据格式无效");
  const payload = input as Partial<ExtractedNote>;
  if (!payload.url || !Array.isArray(payload.topics)) {
    throw new Error("提取数据缺少必要字段");
  }
}
