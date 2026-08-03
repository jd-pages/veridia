import { describe, expect, it } from "vitest";
import {
  estimateUpdateSeconds,
  formatUpdateBytes,
  formatUpdateSpeed,
  updateModeLabel,
} from "@/lib/update-download-progress";

describe("desktop update download progress", () => {
  it("formats transferred size and speed", () => {
    expect(formatUpdateBytes(12.5 * 1024 * 1024)).toBe("12.5 MB");
    expect(formatUpdateSpeed(2 * 1024 * 1024)).toBe("2.0 MB/s");
  });

  it("estimates remaining seconds", () => {
    expect(estimateUpdateSeconds(20, 100, 10)).toBe(8);
    expect(estimateUpdateSeconds(20, 100, 0)).toBeNull();
  });

  it("shows differential, fallback, and detection labels", () => {
    expect(updateModeLabel("differential")).toBe("差分更新");
    expect(updateModeLabel("full")).toContain("完整更新");
    expect(updateModeLabel("checking")).toBe("正在确认差分更新");
  });
});
