import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureProjectBoundDirectory } from "../../scripts/testing/project-bound-cache.mjs";

const temporaryRoots: string[] = [];

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-cache-root-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("项目根绑定缓存", () => {
  it("没有项目根标记的旧缓存会被重建", () => {
    const root = temporaryRoot();
    const cache = path.join(root, "cache");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, "legacy.js"), "legacy\n");

    const result = ensureProjectBoundDirectory(cache, root);

    expect(result.reset).toBe(true);
    expect(fs.existsSync(path.join(cache, "legacy.js"))).toBe(false);
  });

  it("项目根变化时删除旧缓存并写入新根标记", () => {
    const root = temporaryRoot();
    const cache = path.join(root, "cache");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, ".veridia-project-root"), "C:\\old-root\n");
    fs.writeFileSync(path.join(cache, "stale.js"), "stale\n");

    const currentRoot = path.join(root, "current-project");
    const result = ensureProjectBoundDirectory(cache, currentRoot);

    expect(result.reset).toBe(true);
    expect(fs.existsSync(path.join(cache, "stale.js"))).toBe(false);
    expect(fs.readFileSync(result.markerPath, "utf8").trim()).toBe(
      path.resolve(currentRoot),
    );
  });

  it("项目根一致时保留缓存", () => {
    const root = temporaryRoot();
    const cache = path.join(root, "cache");
    ensureProjectBoundDirectory(cache, root);
    fs.writeFileSync(path.join(cache, "reusable.js"), "ok\n");

    const result = ensureProjectBoundDirectory(cache, root);

    expect(result.reset).toBe(false);
    expect(fs.existsSync(path.join(cache, "reusable.js"))).toBe(true);
  });
});
