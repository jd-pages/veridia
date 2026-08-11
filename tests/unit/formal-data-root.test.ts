import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  defaultVeridiaControlRoot,
  resolveFormalDataRoot,
} from "../../scripts/formal-data-root.mjs";

const temporaryRoots: string[] = [];

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-formal-data-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("正式数据目录解析", () => {
  it("优先使用显式环境变量", () => {
    const explicitRoot = path.join(temporaryRoot(), "explicit-data");
    expect(
      resolveFormalDataRoot({
        environment: { VERIDIA_PRODUCTION_DATA_DIR: explicitRoot },
      }),
    ).toBe(path.resolve(explicitRoot));
  });

  it("默认读取桌面端 data-location 配置", () => {
    const controlRoot = temporaryRoot();
    const configuredRoot = path.join(temporaryRoot(), "configured-data");
    const configPath = path.join(controlRoot, "config", "data-location.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({ schemaVersion: 1, dataDirectory: configuredRoot })}\n`,
      "utf8",
    );

    expect(resolveFormalDataRoot({ environment: {}, controlRoot })).toBe(
      path.resolve(configuredRoot),
    );
  });

  it("没有配置时与桌面端默认 LocalAppData 数据根一致", () => {
    const localAppData = temporaryRoot();
    const environment = { LOCALAPPDATA: localAppData };
    const expected = path.join(localAppData, "VERIDIA");

    expect(defaultVeridiaControlRoot({ environment })).toBe(expected);
    expect(resolveFormalDataRoot({ environment })).toBe(expected);
  });
});
