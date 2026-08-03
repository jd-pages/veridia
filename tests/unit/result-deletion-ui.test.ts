import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("审核结果删除界面", () => {
  it("管理员保留单条删除，管理员和审核员共享批量删除", () => {
    const page = source("app/(admin)/results/page.tsx");
    const batchBar = source("components/results/BatchActionBar.tsx");
    expect(page).toContain('const canDeleteSingle = currentRole === "ADMIN"');
    expect(page).toContain("const canDeleteBatch = canOperate");
    expect(page).toContain("if (canDeleteSingle)");
    expect(page).toContain("canDelete={canDeleteBatch}");
    expect(batchBar).toContain("{canDelete && (");
    expect(batchBar).toContain(
      '{selectedCount ? `批量删除（${selectedCount}）` : "批量删除"}',
    );
    expect(batchBar).toContain("disabled={selectedCount === 0 || deleting}");
  });

  it("保留查看详情并提供规定的确认文案与危险按钮", () => {
    const page = source("app/(admin)/results/page.tsx");
    expect(page).toContain("查看详情 <RightOutlined />");
    expect(page).toContain('label: "删除该结果"');
    expect(page).toContain("确认删除该审核结果？");
    expect(page).toContain("确认批量删除？");
    expect(page).toContain(
      "确认删除已选择的 ${count} 条审核结果？删除后不可恢复。",
    );
    expect(page).toContain('okButtonProps: { danger: true }');
    expect(page).toContain('cancelText: "取消"');
    expect(page).toContain('okText: "确认删除"');
  });

  it("删除成功后保持筛选、刷新统计、清空选择并防止重复提交", () => {
    const page = source("app/(admin)/results/page.tsx");
    expect(page).toContain("deleteLockRef.current");
    expect(page).toContain("setSelected([])");
    expect(page).toContain("appliedFilters,");
    expect(page).toContain("appliedAdvancedFilters,");
    expect(page).toContain("pageAfterResultDeletion({");
    expect(page).toContain("已成功删除 ${result.deletedCount} 条审核结果");
  });
});
