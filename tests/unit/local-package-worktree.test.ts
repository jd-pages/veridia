import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LOCAL_PACKAGE_RESTORE_FILES,
  withLocalPackageFileRestore,
  writeLocalPackageAcceptance,
} from "../../scripts/testing/local-package-worktree.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-local-package-"));
  const originals = new Map<string, Buffer>();
  const contents: Record<string, Buffer> = {
    "package.json": Buffer.from('{"version":"1.1.17"}\r\n'),
    "package-lock.json": Buffer.from('{"version":"1.1.17"}\n'),
    "CHANGELOG.md": Buffer.from("# Changelog\r\n"),
    "tsconfig.json": Buffer.from(
      '{\r\n  "include": [".next/types/**/*.ts"]\r\n}\r\n',
    ),
    "next-env.d.ts": Buffer.from('import "./.next/types/routes.d.ts";\n'),
  };
  for (const [relativePath, content] of Object.entries(contents)) {
    const file = path.join(root, relativePath);
    fs.writeFileSync(file, content);
    originals.set(relativePath, Buffer.from(content));
  }
  return { originals, root };
}

describe("本地打包工作区恢复", () => {
  it("finally 精确恢复版本文件及 Next 副作用文件，但不吞掉普通源码修改", async () => {
    const { originals, root } = fixture();
    const source = path.join(root, "lib", "foo.ts");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "export const clean = true;\n", "utf8");

    await withLocalPackageFileRestore(root, () => {
      fs.writeFileSync(
        path.join(root, "package.json"),
        '{"version":"1.1.18"}\n',
      );
      fs.writeFileSync(path.join(root, "package-lock.json"), "changed\n");
      fs.writeFileSync(path.join(root, "CHANGELOG.md"), "changed\n");
      fs.writeFileSync(
        path.join(root, "tsconfig.json"),
        JSON.stringify({
          include: [
            ".next/types/**/*.ts",
            ".next-preview-3100/types/**/*.ts",
            ".next-preview-3100/dev/types/**/*.ts",
          ],
        }),
      );
      fs.writeFileSync(
        path.join(root, "next-env.d.ts"),
        'import "./.next-preview-3100/dev/types/routes.d.ts";\n',
      );
      fs.writeFileSync(source, "export const clean = false;\n", "utf8");
    });

    for (const relativePath of LOCAL_PACKAGE_RESTORE_FILES) {
      expect(fs.readFileSync(path.join(root, relativePath))).toEqual(
        originals.get(relativePath),
      );
    }
    expect(fs.readFileSync(source, "utf8")).toBe(
      "export const clean = false;\n",
    );
  });

  it("普通源码为 dirty 时完整门禁阻断且不生成 acceptance.json", () => {
    const { root } = fixture();
    const acceptancePath = path.join(root, ".release-work", "acceptance.json");

    expect(() =>
      writeLocalPackageAcceptance({
        acceptancePath,
        acceptance: { version: "1.1.17" },
        worktreeStatus: " M lib/foo.ts",
      }),
    ).toThrow("工作区不干净");
    expect(fs.existsSync(acceptancePath)).toBe(false);
  });

  it("只有完整工作区 clean 时才生成 acceptance.json", () => {
    const { root } = fixture();
    const acceptancePath = path.join(root, ".release-work", "acceptance.json");

    writeLocalPackageAcceptance({
      acceptancePath,
      acceptance: { version: "1.1.17" },
      worktreeStatus: "",
    });

    expect(JSON.parse(fs.readFileSync(acceptancePath, "utf8"))).toEqual({
      version: "1.1.17",
    });
  });
});
