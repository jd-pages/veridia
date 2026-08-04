import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Excel 自动审核预检表格布局", () => {
  it("把宽表限制在卡片内并通过表格内部横向滚动展示完整结果列", async () => {
    const page = await readFile("app/(admin)/tasks/page.tsx", "utf8");
    const css = await readFile("app/(admin)/tasks/tasks.module.css", "utf8");
    const previewTable = page.slice(
      page.indexOf("<div className={styles.previewTableShell}>"),
      page.indexOf(
        "</div>",
        page.indexOf("<div className={styles.previewTableShell}>"),
      ),
    );

    expect(previewTable).toContain('tableLayout="fixed"');
    expect(previewTable).toContain("scroll={{ x: 1500 }}");
    expect(previewTable).not.toContain("sticky=");
    expect(previewTable).toMatch(/产品阶段话题[\s\S]*?width: 130/u);
    expect(previewTable).toMatch(/title: "预检结果"[\s\S]*?width: 220/u);
    expect(previewTable).toContain("showSizeChanger: false");
    expect(page).toContain(".map((item) => item.displayName)");

    expect(css).toMatch(
      /\.previewTableShell[\s\S]*?max-width: 100%;[\s\S]*?overflow: hidden;/u,
    );
    expect(css).toMatch(
      /\.previewTableShell :global\(\.ant-table-content\)[\s\S]*?overflow-x: auto !important;/u,
    );
    expect(css).toContain(".previewEllipsis");
    expect(css).toContain(".previewResult");
  });
});
