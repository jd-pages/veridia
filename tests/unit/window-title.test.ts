import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("VERIDIA window titles", () => {
  it("unifies browser, Electron and data-location window titles as VERIDIA", () => {
    const layout = source("app/layout.tsx");
    const desktopMain = source("desktop/main.cjs");
    const dataLocationWindow = source("desktop/data-location.html");
    expect(layout).toContain('title: "VERIDIA"');
    expect(desktopMain).toContain('const APP_NAME = "VERIDIA"');
    expect(desktopMain).toContain("title: APP_NAME");
    expect(dataLocationWindow).toContain("<title>VERIDIA</title>");
    expect(`${layout}\n${desktopMain}\n${dataLocationWindow}`).not.toContain(
      "内容治理审核系统",
    );
  });
});
