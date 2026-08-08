import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("本地字体资源", () => {
  it("正式入口只加载固定版本的本地字体包", () => {
    const layout = fs.readFileSync(path.join(root, "app/layout.tsx"), "utf8");
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };

    expect(layout).not.toContain("next/font/google");
    expect(layout).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/u);
    for (const family of ["inter", "manrope", "noto-sans-sc", "noto-serif-sc"]) {
      const dependency = `@fontsource-variable/${family}`;
      expect(layout).toContain(`${dependency}/wght.css`);
      expect(packageJson.dependencies[dependency]).toBe("5.3.0");
    }
  });

  it("保持现有字体变量并随安装包分发许可", () => {
    const globalCss = fs.readFileSync(path.join(root, "app/globals.css"), "utf8");
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { build: { files: string[] } };

    expect(globalCss).toContain('--font-manrope: "Manrope Variable"');
    expect(globalCss).toContain('--font-inter: "Inter Variable"');
    expect(globalCss).toContain('--font-noto-sans-sc: "Noto Sans SC Variable"');
    expect(globalCss).toContain('--font-noto-serif-sc: "Noto Serif SC Variable"');
    expect(packageJson.build.files).toContain("assets/fonts/**/*");
    expect(fs.existsSync(path.join(root, "assets/fonts/OFL-1.1.txt"))).toBe(true);
    expect(fs.existsSync(path.join(root, "assets/fonts/README.md"))).toBe(true);
  });
});
