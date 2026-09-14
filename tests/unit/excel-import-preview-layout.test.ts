import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Excel 自动审核预检表格布局", () => {
  it("把预检结果固定在首个业务列并提供视口底部同步横向滚动", async () => {
    const page = await readFile("app/(admin)/tasks/page.tsx", "utf8");
    const css = await readFile("app/(admin)/tasks/tasks.module.css", "utf8");
    const previewStart = page.indexOf(
      "<div className={styles.previewTableShell}>",
    );
    const previewTable = page.slice(
      previewStart,
      page.indexOf("</Table>", previewStart) > 0
        ? page.indexOf("</Table>", previewStart) + "</Table>".length
        : page.indexOf("pagination={{", previewStart) + 1_000,
    );

    expect(previewTable).toContain('tableLayout="fixed"');
    expect(previewTable).toContain("scroll={{ x: 1820 }}");
    expect(previewTable).toContain("sticky={{ offsetHeader: 64, offsetScroll: 8 }}");
    expect(previewTable).toContain("fixed: true");
    expect(previewTable).toMatch(/产品阶段话题[\s\S]*?width: 130/u);
    expect(previewTable).toMatch(/title: "预检结果"[\s\S]*?width: 320,[\s\S]*?fixed: "left"/u);
    expect(previewTable.indexOf('title: "预检结果"')).toBeLessThan(
      previewTable.indexOf('title: "Sheet / 行"'),
    );
    expect(previewTable).toContain("row.warnings");
    expect(previewTable).toContain('<Tag color="green">通过</Tag>');
    expect(previewTable).toContain('<Tag color="orange">警告</Tag>');
    expect(previewTable).toContain('<Tag color="red">失败</Tag>');
    expect(previewTable).toContain("showSizeChanger: false");
    expect(previewTable).toContain("current: previewPage");
    expect(page).toContain("当前仅显示异常记录，共");
    expect(page).toContain("预检查通过，无异常记录");
    expect(page).toContain("查看全部记录");
    expect(page).toContain("仅看异常");
    expect(page).toContain("preview.errorRows");
    expect(page).toContain(".map((item) => item.displayName)");

    expect(css).toMatch(
      /\.previewTableShell[\s\S]*?max-width: 100%;[\s\S]*?overflow: visible;/u,
    );
    expect(css).toMatch(
      /\.previewTableShell :global\(\.ant-table-content\)[\s\S]*?overflow-x: auto !important;/u,
    );
    expect(css).toContain(".previewEllipsis");
    expect(css).toContain(".previewResult");
    expect(css).toContain(".previewResultText");
    expect(css).toContain(".ant-table-sticky-scroll");
  });
});
