import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("审核结果表格布局", () => {
  const page = source("app/(admin)/results/page.tsx");
  const styles = source(
    "components/results/results-workbench.module.css",
  );
  const imageCell = source("components/results/ImageAuditCell.tsx");

  it("固定右侧操作列并为查看详情和更多操作保留固定宽度", () => {
    expect(page).toMatch(
      /title: "操作",[\s\S]*?width: 160,[\s\S]*?fixed: "right",[\s\S]*?className: styles\.actionsColumn/,
    );
    expect(page).toContain("查看详情 <RightOutlined />");
    expect(page).toContain('aria-label="更多操作"');
    expect(styles).toContain(".actionsColumn");
    expect(styles).toContain("box-shadow: -8px 0 14px -14px");
  });

  it("收紧内容列并使用固定表格布局防止长文本撑宽", () => {
    expect(page).toMatch(/title: "归属信息",[\s\S]*?width: 240/);
    expect(page).toMatch(/title: "话题审核",[\s\S]*?width: 180/);
    expect(page).toMatch(/title: "图片",[\s\S]*?width: 120/);
    expect(page).toMatch(/title: "正文审核",[\s\S]*?width: 130/);
    expect(page).toMatch(/title: "审核结论",[\s\S]*?width: 250/);
    expect(page).toContain('tableLayout="fixed"');
    expect(page).toContain("scroll={{ x: 1410 }}");
    expect(page).not.toContain("<ContentStatusCell");
    expect(styles).toContain(".ownershipCampaign");
    expect(styles).toContain("text-overflow: ellipsis;");
  });

  it("长失败原因最多显示两行且图片数量继续读取实际识别结果", () => {
    expect(styles).toMatch(
      /\.reasonText\s*\{[\s\S]*?-webkit-line-clamp: 2;/,
    );
    expect(imageCell).toContain("`${row.imageCount} 张`");
    expect(imageCell).not.toContain('"2 张"');
    expect(imageCell).not.toContain('"2张"');
  });

  it("列表不展示笔记ID且审核结论直接展示具体原因", () => {
    const noteCell = source("components/results/NoteObjectCell.tsx");
    const conclusionCell = source("components/results/AuditConclusionCell.tsx");
    expect(noteCell).not.toContain("platformNoteId");
    expect(noteCell).not.toContain("笔记ID");
    expect(conclusionCell).toContain('reasons.join("；")');
    expect(conclusionCell).not.toContain("项异常");
  });
});
