import { describe, expect, it } from "vitest";
import { pageAfterResultDeletion } from "@/components/results/deletion-state";

describe("删除结果后的分页", () => {
  it("删除当前页最后一条时回到上一有效页", () => {
    expect(
      pageAfterResultDeletion({
        total: 21,
        page: 2,
        pageSize: 20,
        deletedCount: 1,
      }),
    ).toBe(1);
  });

  it("当前页仍有效时保持页码", () => {
    expect(
      pageAfterResultDeletion({
        total: 22,
        page: 2,
        pageSize: 20,
        deletedCount: 1,
      }),
    ).toBe(2);
  });

  it("列表清空后保持有效的第一页", () => {
    expect(
      pageAfterResultDeletion({
        total: 2,
        page: 1,
        pageSize: 20,
        deletedCount: 2,
      }),
    ).toBe(1);
  });
});
