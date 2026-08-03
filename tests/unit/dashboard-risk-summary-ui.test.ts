import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("仪表盘风险摘要", () => {
  const dashboard = source("app/(admin)/dashboard/page.tsx");
  const resultPage = source("app/(admin)/results/page.tsx");
  const filterPanel = source("components/results/AuditFilterPanel.tsx");
  const riskStart = dashboard.indexOf("const riskItems");
  const riskBlock = dashboard.slice(
    riskStart,
    dashboard.indexOf("\n\n  return (", riskStart),
  );

  it("风险配置只保留笔记不存在、话题缺失和图片不足", () => {
    expect(riskBlock).toContain('label: "笔记不存在"');
    expect(riskBlock).toContain('label: "话题缺失"');
    expect(riskBlock).toContain('label: "图片不足"');
    expect(riskBlock).not.toContain('label: "读取失败"');
    expect(riskBlock).not.toContain('label: "蓝色话题异常"');
  });

  it("隐藏零值风险并在全部为零时显示空状态", () => {
    expect(riskBlock).toContain(".filter((item) => item.value > 0)");
    expect(dashboard).toContain("暂无风险");
  });

  it("三个入口传递专用风险筛选，结果页读取、展示且可重置", () => {
    for (const riskType of [
      "NOTE_UNAVAILABLE",
      "TOPIC_MISSING",
      "IMAGE_INSUFFICIENT",
    ]) {
      expect(riskBlock).toContain(`riskType: "${riskType}"`);
    }
    expect(resultPage).toContain("filtersFromSearchParams");
    expect(resultPage).toContain('value("riskType")');
    expect(resultPage).toContain('router.replace("/results"');
    expect(filterPanel).toContain("风险类型：");
  });
});
