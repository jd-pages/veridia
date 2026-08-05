import { describe, expect, it } from "vitest";
import {
  buildTaskExecutionFilterWhere,
  countTaskStatuses,
  parseTaskExecutionFilter,
  taskExecutionStatusGroups,
} from "@/lib/automation/task-execution-filter";

describe("审核执行记录状态筛选", () => {
  it("将等待、处理、成功和失败映射到真实任务状态", () => {
    expect(buildTaskExecutionFilterWhere("WAITING")).toEqual({
      status: { in: ["PENDING", "QUEUED"] },
    });
    expect(buildTaskExecutionFilterWhere("PROCESSING")).toEqual({
      status: { in: ["PROCESSING", "RUNNING"] },
    });
    expect(buildTaskExecutionFilterWhere("SUCCEEDED")).toEqual({
      status: { in: ["COMPLETED"] },
    });
    expect(buildTaskExecutionFilterWhere("FAILED")).toEqual({
      status: { in: ["FAILED", "READ_FAILED"] },
    });
  });

  it("待人工复核使用审核结果和人工状态，不与执行失败合并", () => {
    const where = buildTaskExecutionFilterWhere("NEEDS_REVIEW");

    expect(where).toHaveProperty("OR");
    expect(JSON.stringify(where)).toContain('"status":"NEEDS_REVIEW"');
    expect(JSON.stringify(where)).toContain('"autoStatus":"NEEDS_REVIEW"');
    expect(JSON.stringify(where)).toContain('"result":"NEEDS_REVIEW"');
    expect(JSON.stringify(where)).toContain('"PASSED","FAILED"');
  });

  it("解析筛选值并按兼容状态累计卡片数量", () => {
    expect(parseTaskExecutionFilter(undefined)).toBe("ALL");
    expect(parseTaskExecutionFilter("succeeded")).toBe("SUCCEEDED");
    expect(parseTaskExecutionFilter("unknown")).toBeNull();

    const counts = new Map([
      ["PENDING", 2],
      ["QUEUED", 1],
      ["FAILED", 1],
      ["READ_FAILED", 2],
    ]);
    expect(countTaskStatuses(counts, taskExecutionStatusGroups.WAITING)).toBe(3);
    expect(countTaskStatuses(counts, taskExecutionStatusGroups.FAILED)).toBe(3);
  });
});
