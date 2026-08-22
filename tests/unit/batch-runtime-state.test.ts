import { describe, expect, it } from "vitest";
import {
  classifyBatchRuntimeState,
  isLiveBatchExecutionStateCoherent,
} from "@/lib/automation/runtime-state";

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

  it("runner 刚选中 QUEUED 批次但尚未 claim 时属于合法过渡态", () => {
    expect(isLiveBatchExecutionStateCoherent({
      status: "QUEUED",
      runEpoch: 0,
      currentTaskId: null,
      processingTasks: [],
    })).toBe(true);
  });

  it("RUNNING 批次在相邻 task claim 之间属于合法过渡态", () => {
    expect(isLiveBatchExecutionStateCoherent({
      status: "RUNNING",
      runEpoch: 2,
      currentTaskId: null,
      processingTasks: [],
    })).toBe(true);
  });

  it("runner 与 PROCESSING lease 不一致时仍要求人工复核", () => {
    expect(isLiveBatchExecutionStateCoherent({
      status: "RUNNING",
      runEpoch: 2,
      currentTaskId: "task-current",
      processingTasks: [{ id: "task-stale", claimEpoch: 1 }],
    })).toBe(false);
  });

  it("PAUSED 批次无 lease 时不视为正在合法过渡", () => {
    expect(isLiveBatchExecutionStateCoherent({
      status: "PAUSED",
      runEpoch: 2,
      currentTaskId: null,
      processingTasks: [],
    })).toBe(false);
  });
});
