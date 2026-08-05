import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import builtinRules from "@/rules/default-rules.json";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("达能月度规则拆分", () => {
  it("7月与8月使用独立活动、独立规则主键和准确段位话题", () => {
    const july = builtinRules.campaigns.find(
      (campaign) => campaign.name === "爱他美2026年7月小红书种草审核",
    );
    const august = builtinRules.campaigns.find(
      (campaign) => campaign.key === "activity_danone_2026_08",
    );
    const julyKeys = new Set(
      builtinRules.topicRules
        .filter((rule) => rule.campaignKey === july?.key)
        .map((rule) => rule.key),
    );
    const augustRules = builtinRules.topicRules.filter(
      (rule) => rule.campaignKey === august?.key,
    );

    expect(july?.month).toBe("2026-07");
    expect(august?.month).toBe("2026-08");
    expect(augustRules).toHaveLength(9);
    expect(augustRules.every((rule) => !julyKeys.has(rule.key))).toBe(true);
    expect(
      augustRules
        .filter((rule) => rule.topicCategory === "PRODUCT_STAGE")
        .map((rule) => [rule.applicableStage, rule.topic]),
    ).toEqual([
      ["IFFO_P1", "#新生儿奶粉"],
      ["IFFO_2", "#二段奶粉推荐"],
      ["GUM_3_4_1PLUS_2PLUS", "#三段奶粉推荐"],
    ]);
  });

  it("迁移只新增8月活动及规则，不删除或重写历史审核数据", () => {
    const migration = source(
      "prisma/migrations/202608050005_danone_august_monthly_rules/migration.sql",
    );

    expect(migration).toContain("INSERT OR IGNORE INTO \"campaigns\"");
    expect(migration).toContain("INSERT OR IGNORE INTO \"topic_rules\"");
    expect(migration).toContain("'2026-08'");
    expect(migration).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE)\b/iu);
    expect(migration).not.toMatch(/\b(?:UPDATE|INSERT)\s+(?:INTO\s+)?"audit_/iu);
  });
});
