import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import builtinRules from "@/rules/default-rules.json";
import { validateRulePayload } from "@/lib/rules/package";
import { prepareRulePublishSource } from "@/lib/rules/publish-source";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalRuleDatabasePath = process.env.VERIDIA_RULE_DATABASE_PATH;
const originalProjectSource = process.env.VERIDIA_RULE_PROJECT_SOURCE;

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalRuleDatabasePath === undefined) {
    delete process.env.VERIDIA_RULE_DATABASE_PATH;
  } else {
    process.env.VERIDIA_RULE_DATABASE_PATH = originalRuleDatabasePath;
  }
  if (originalProjectSource === undefined) {
    delete process.env.VERIDIA_RULE_PROJECT_SOURCE;
  } else {
    process.env.VERIDIA_RULE_PROJECT_SOURCE = originalProjectSource;
  }
});

function readiness(
  databasePath: string,
  source: "DESKTOP_DATA_LOCATION" | "VERIDIA_RULE_DATABASE_PATH" =
    "DESKTOP_DATA_LOCATION",
) {
  return {
    migrated: false,
    readOnly: true,
    database: {
      databasePath,
      databaseUrl: `file:${databasePath.replaceAll("\\", "/")}?mode=ro`,
      source,
    },
    structure: {
      hasRequireBodyStage: true,
      requireBodyStageDefaultsToFalse: true,
      hasStoreTopicRules: true,
      hasStoreTopicEntries: true,
    },
  };
}

describe("规则发布来源", () => {
  it("普通发布默认使用 Desktop 正式数据库且不回退项目规则", async () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "veridia-rule-source-"),
    );
    const databasePath = path.join(temporaryRoot, "veridia.db");
    fs.writeFileSync(databasePath, "read-only-source");
    const ensureDatabaseReady = vi.fn(async () => readiness(databasePath));
    const databasePayload = validateRulePayload(builtinRules);
    const exportDatabasePayload = vi.fn(async () => databasePayload);

    try {
      const source = await prepareRulePublishSource({
        ruleDatabasePath: null,
        ensureDatabaseReady,
        exportDatabasePayload,
      });
      expect(source.source).toBe("DESKTOP_DATA_LOCATION");
      expect(source.sourcePath).toBe(databasePath);
      await expect(
        source.createPayload({
          ruleVersion: "rules-2026.08.22.1",
          minimumAppVersion: "1.1.17",
        }),
      ).resolves.toBe(databasePayload);
      expect(ensureDatabaseReady).toHaveBeenCalledOnce();
      expect(exportDatabasePayload).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("显式数据库 override 保持最高优先级", async () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "veridia-rule-override-"),
    );
    const databasePath = path.join(temporaryRoot, "publisher.db");
    fs.writeFileSync(databasePath, "override-source");
    const ensureDatabaseReady = vi.fn(async () =>
      readiness(databasePath, "VERIDIA_RULE_DATABASE_PATH"),
    );
    try {
      const source = await prepareRulePublishSource({
        ruleDatabasePath: databasePath,
        projectSourceEnabled: true,
        ensureDatabaseReady,
        exportDatabasePayload: async () => validateRulePayload(builtinRules),
      });
      expect(source.source).toBe("VERIDIA_RULE_DATABASE_PATH");
      expect(process.env.VERIDIA_RULE_DATABASE_PATH).toBe(databasePath);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("项目 default-rules 仅在显式开发者模式启用", async () => {
    const source = await prepareRulePublishSource({
      ruleDatabasePath: null,
      projectSourceEnabled: true,
    });
    expect(source.source).toBe("PROJECT_RULE_SOURCE");
    expect(source.sourcePath).toBe(
      path.join(process.cwd(), "rules", "default-rules.json"),
    );
    const payload = await source.createPayload({
      ruleVersion: "rules-2026.08.22.2",
      minimumAppVersion: "1.1.17",
      publishedAt: new Date("2026-08-22T00:00:00.000Z"),
    });
    expect(payload.ruleVersion).toBe("rules-2026.08.22.2");
    expect(payload.storeTopicRules).toBeUndefined();
  });

  it("Desktop 数据库定位失败时直接 BLOCKED，不读取 default-rules", async () => {
    const ensureDatabaseReady = vi.fn(async () => {
      throw new Error("未找到 VERIDIA 当前规则数据库");
    });
    await expect(
      prepareRulePublishSource({
        ruleDatabasePath: null,
        projectSourceEnabled: false,
        ensureDatabaseReady,
        projectRuleSourcePath: path.join(
          process.cwd(),
          "rules",
          "default-rules.json",
        ),
      }),
    ).rejects.toThrow(/未找到 VERIDIA 当前规则数据库/u);
  });

  it("导出期间主库或 WAL sidecar 变化会阻断发布", async () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "veridia-rule-guard-"),
    );
    const databasePath = path.join(temporaryRoot, "veridia.db");
    fs.writeFileSync(databasePath, "before");
    try {
      const source = await prepareRulePublishSource({
        ruleDatabasePath: databasePath,
        ensureDatabaseReady: async () =>
          readiness(databasePath, "VERIDIA_RULE_DATABASE_PATH"),
        exportDatabasePayload: async () => {
          fs.writeFileSync(`${databasePath}-wal`, "changed");
          return validateRulePayload(builtinRules);
        },
      });
      await expect(
        source.createPayload({
          ruleVersion: "rules-2026.08.22.3",
          minimumAppVersion: "1.1.17",
        }),
      ).rejects.toThrow(/SQLite sidecar.*发生变化/u);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("BAT 禁止项目源 fallback，发布器保持 Draft → 远端复核 → Latest", () => {
    const bat = new TextDecoder("gbk").decode(
      fs.readFileSync(path.join(process.cwd(), "发布规则新版.bat")),
    );
    expect(bat).toContain("chcp 936 >nul");
    expect(bat).toContain('set "VERIDIA_RULE_PROJECT_SOURCE="');
    expect(bat).toContain("data-location.json");
    expect(bat).toContain("不会回退发布 rules\\default-rules.json");

    const publisher = fs.readFileSync(
      path.join(process.cwd(), "scripts", "publish-rules.ts"),
      "utf8",
    );
    const createDraft = publisher.indexOf('    "--draft",');
    const downloadRemote = publisher.indexOf('    "download",', createDraft);
    const publishLatest = publisher.indexOf('    "--draft=false",', downloadRemote);
    expect(createDraft).toBeGreaterThan(-1);
    expect(downloadRemote).toBeGreaterThan(createDraft);
    expect(publishLatest).toBeGreaterThan(downloadRemote);
    expect(publisher).toContain("storeTopicRuleCount");
    expect(publisher).toContain("storeAliasCount");
  });
});
