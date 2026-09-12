import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("桌面软件版本入口", () => {
  it("只保留版本信息和手工安装所需的数据位置能力", () => {
    const settings = source("app/(admin)/settings/page.tsx");
    const softwareCard = settings.slice(
      settings.indexOf('title="软件信息"'),
      settings.indexOf('title="规则同步"'),
    );

    for (const label of ["当前版本", "构建日期", "数据库版本", "数据保存位置"]) {
      expect(softwareCard).toContain(label);
    }
    expect(softwareCard).toContain("更改数据位置");
    expect(softwareCard).not.toContain("检查更新");
    expect(softwareCard).not.toContain("自动更新");
    expect(softwareCard).not.toContain("下载更新");
    expect(softwareCard).not.toContain("安装更新");
  });

  it("完整保留远程 Rules 更新入口", () => {
    const settings = source("app/(admin)/settings/page.tsx");
    const rulesCard = settings.slice(settings.indexOf('title="规则同步"'));

    for (const label of [
      "当前规则版本",
      "最新远程版本",
      "检查更新",
      "立即同步",
      "查看同步记录",
      "恢复上一版规则",
    ]) {
      expect(rulesCard).toContain(label);
    }
    expect(rulesCard).toContain("/api/rule-sync/check?force=true");
    expect(rulesCard).toContain("/api/rule-sync/apply");
  });
});
