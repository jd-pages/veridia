import { describe, expect, it } from "vitest";
import { nextSelectedProductStage } from "@/lib/product-stage-selection";

describe("手动任务所属阶段联动", () => {
  const iffo = { value: "IFFO", label: "IFFO" };
  const gum = { value: "GUM", label: "GUM" };

  it("单一阶段自动选择", () => {
    expect(nextSelectedProductStage([gum], null)).toBe("GUM");
  });

  it("多阶段没有用户选择时保持未选", () => {
    expect(nextSelectedProductStage([iffo, gum], null)).toBeNull();
  });

  it("多阶段保留仍然有效的明确选择", () => {
    expect(nextSelectedProductStage([iffo, gum], "GUM")).toBe("GUM");
  });

  it("无阶段禁止产生默认值", () => {
    expect(nextSelectedProductStage([], "GUM")).toBeNull();
  });

  it("切换产品后旧阶段不在新选项中则重置", () => {
    expect(nextSelectedProductStage([iffo], "GUM")).toBe("IFFO");
    expect(nextSelectedProductStage([iffo, gum], "LEGACY")).toBeNull();
  });
});
