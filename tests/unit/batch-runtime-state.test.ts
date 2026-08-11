import { describe, expect, it } from "vitest";
import { classifyBatchRuntimeState } from "@/lib/automation/runtime-state";

describe("自动审核批次真实运行态", () => {
  it("数据库 RUNNING 但没有 runner 时判定 STALE", () => {
    expect(classifyBatchRuntimeState({
      status: "RUNNING",
      processingTaskCount: 150,
      currentTaskId: null,
      activeRunner: false,
    })).toBe("STALE");
  });

  it("存在当前真实 runner 时优先判定 LIVE", () => {
    expect(classifyBatchRuntimeState({
      status: "RUNNING",
      processingTaskCount: 1,
      currentTaskId: "task-37",
      activeRunner: true,
    })).toBe("LIVE");
  });

  it("终态且没有残留执行标记时判定 INACTIVE", () => {
    expect(classifyBatchRuntimeState({
      status: "CANCELLED",
      processingTaskCount: 0,
      currentTaskId: null,
      activeRunner: false,
    })).toBe("INACTIVE");
  });

  it("暂停批次仍残留 PROCESSING 时判定 STALE", () => {
    expect(classifyBatchRuntimeState({
      status: "PAUSED",
      processingTaskCount: 1,
      currentTaskId: null,
      activeRunner: false,
    })).toBe("STALE");
  });
});
