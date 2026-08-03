import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("登录页辅助入口", () => {
  const screen = source("components/LocalLoginScreen.tsx");
  const styles = source("app/globals.css");

  it("只保留三个入口并移除本机凭证说明", () => {
    expect(screen).toContain("激活账号");
    expect(screen).toContain("导入密码重置码");
    expect(screen).toContain("导入账号更新码");
    expect(screen).not.toContain(
      "账号与登录凭证仅保存在本机，不提供在线注册或在线找回密码。",
    );
    expect(screen).not.toContain("Typography.Text");
  });

  it("保留三个入口原有行为并使用居中布局", () => {
    expect(screen).toContain('href="/activate"');
    expect(screen).toContain("onClick={() => setResetOpen(true)}");
    expect(screen).toContain("onClick={() => setUpdateOpen(true)}");
    expect(screen).toContain('className="login-help-actions"');
    expect(styles).toMatch(
      /\.login-help-actions\s*\{[\s\S]*?justify-content: center;/,
    );
  });
});
