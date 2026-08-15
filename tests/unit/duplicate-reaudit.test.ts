import { describe, expect, it } from "vitest";
import {
  duplicateReauditMetadataFromNotes,
  resolveDuplicateReauditAutomaticOutcome,
  withDuplicateReauditMetadata,
} from "@/lib/import-task-metadata";

const metadata = {
  identity: "xhs-note:66abc",
  historicalCount: 2,
  confirmedAt: "2026-08-15T00:00:00.000Z",
  confirmedByUserId: "user-1",
  confirmedByDisplayName: "审核员",
  sourceTaskIds: ["task-old-1", "task-old-2"],
};

describe("重复重审任务元数据与自动结论", () => {
  it("结构化元数据可往返且不破坏原导入备注", () => {
    const notes = withDuplicateReauditMetadata("订单编号：ORDER-1", metadata);
    expect(notes).toContain("订单编号：ORDER-1");
    expect(duplicateReauditMetadataFromNotes(notes)).toEqual(metadata);
  });

  it.each(["PASSED", "FAILED"])(
    "重复重审自动结果 %s 始终进入待人工确认并保留真实自动结论",
    (automaticResult) => {
      const notes = withDuplicateReauditMetadata("原备注", metadata);
      const outcome = resolveDuplicateReauditAutomaticOutcome(
        notes,
        automaticResult,
      );
      expect(outcome).toMatchObject({
        isDuplicateReaudit: true,
        persistedAutoStatus: "NEEDS_REVIEW",
      });
      expect(duplicateReauditMetadataFromNotes(outcome.notes)).toMatchObject({
        ...metadata,
        automaticResult,
      });
    },
  );

  it("普通任务保持原自动结论与备注", () => {
    expect(
      resolveDuplicateReauditAutomaticOutcome("普通任务", "PASSED"),
    ).toEqual({
      isDuplicateReaudit: false,
      persistedAutoStatus: "PASSED",
      notes: "普通任务",
    });
  });
});
