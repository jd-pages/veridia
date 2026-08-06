import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeStoreNameForMatch } from "@/lib/store-topic-config";
import {
  storeRequiredTopicSeeds,
  storeTopicRuleSeeds,
} from "@/lib/store-topic-rule-seeds";

const root = process.cwd();
const migration = readFileSync(
  path.join(root, "prisma/migrations/202608050006_store_topic_rules/migration.sql"),
  "utf8",
);
const acceptedTopicsMigration = readFileSync(
  path.join(
    root,
    "prisma/migrations/202608060001_store_accepted_topics/migration.sql",
  ),
  "utf8",
);
const sqliteSchema = readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
const postgresSchema = readFileSync(
  path.join(root, "prisma/schema.postgresql.prisma"),
  "utf8",
);
const collectionRoute = readFileSync(
  path.join(root, "app/api/store-topic-rules/route.ts"),
  "utf8",
);
const itemRoute = readFileSync(
  path.join(root, "app/api/store-topic-rules/[id]/route.ts"),
  "utf8",
);
const campaignsPage = readFileSync(
  path.join(root, "app/(admin)/campaigns/page.tsx"),
  "utf8",
);

describe("店铺话题规则数据模型与迁移", () => {
  it("SQLite 与 PostgreSQL 使用相同独立模型和唯一键", () => {
    for (const schema of [sqliteSchema, postgresSchema]) {
      expect(schema).toContain("model StoreTopicRule");
      expect(schema).toContain("model StoreTopicEntry");
      expect(schema).toContain("topicEntries");
      expect(schema).toContain("topicType");
      expect(schema).toContain(
        "@@unique([storeTopicRuleId, normalizedTopic])",
      );
      expect(schema).toContain("normalizedStoreName String");
      expect(schema).toContain("@@unique([commercePlatform, normalizedStoreName])");
      expect(schema).toContain('@@map("store_topic_rules")');
    }
  });

  it("旧 expectedTopic 以幂等方式迁移为第一条可接受话题", () => {
    expect(acceptedTopicsMigration).toContain(
      'CREATE TABLE "store_topic_entries"',
    );
    expect(acceptedTopicsMigration).toContain("INSERT OR IGNORE");
    expect(acceptedTopicsMigration).toContain('FROM "store_topic_rules"');
    expect(acceptedTopicsMigration).not.toMatch(
      /^\s*(?:DELETE|DROP|TRUNCATE)\b/imu,
    );
    expect(acceptedTopicsMigration).not.toMatch(
      /\bUPDATE\s+"?(?:audit_results|audit_tasks)"?/iu,
    );
  });

  it("按平台和完整店铺名幂等初始化京东、天猫、淘宝附加必需话题", () => {
    expect(acceptedTopicsMigration).toContain(
      '"commercePlatform" = \'JD\'',
    );
    expect(acceptedTopicsMigration).toContain("'#京东'");
    expect(acceptedTopicsMigration).toContain(
      '"commercePlatform" = \'TMALL\'',
    );
    expect(acceptedTopicsMigration).toContain("'#天猫'");
    expect(acceptedTopicsMigration).toContain(
      '"commercePlatform" = \'TAOBAO\'',
    );
    expect(acceptedTopicsMigration).toContain("'#淘宝'");
  });

  it("迁移只新增表、字段、索引和幂等种子，不破坏历史数据", () => {
    expect(migration).toContain('CREATE TABLE "store_topic_rules"');
    expect(migration).toContain("INSERT OR IGNORE");
    expect(migration).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE)\b/iu);
    expect(migration).not.toMatch(/\bUPDATE\s+"?(?:audit_results|audit_tasks)"?/iu);
  });

  it("42 条旧清单按平台和大小写归一名称保持唯一", () => {
    expect(storeTopicRuleSeeds).toHaveLength(42);
    const keys = storeTopicRuleSeeds.map(
      (seed) => `${seed.commercePlatform}\u0000${normalizeStoreNameForMatch(seed.storeName)}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("附加平台话题只初始化到指定平台的18家店铺", () => {
    expect(storeRequiredTopicSeeds).toHaveLength(18);
    expect(
      storeRequiredTopicSeeds.filter(
        (seed) => seed.commercePlatform === "JD" && seed.topic === "#京东",
      ),
    ).toHaveLength(12);
    expect(
      storeRequiredTopicSeeds.filter(
        (seed) => seed.commercePlatform === "TMALL" && seed.topic === "#天猫",
      ),
    ).toHaveLength(4);
    expect(
      storeRequiredTopicSeeds
        .filter(
          (seed) => seed.commercePlatform === "TAOBAO" && seed.topic === "#淘宝",
        )
        .map((seed) => seed.storeName)
        .sort(),
    ).toEqual(["ALG阿莱购", "国际进口超市"].sort());
    for (const required of storeRequiredTopicSeeds) {
      expect(
        storeTopicRuleSeeds.some(
          (rule) =>
            rule.commercePlatform === required.commercePlatform &&
            normalizeStoreNameForMatch(rule.storeName) ===
              normalizeStoreNameForMatch(required.storeName),
        ),
      ).toBe(true);
    }
  });

  it("管理入口与读写接口统一使用管理员和审核员业务权限", () => {
    expect(collectionRoute).toContain("requireApiUser(BUSINESS_ROLES)");
    expect(itemRoute).toContain("requireApiUser(BUSINESS_ROLES)");
    expect(campaignsPage).toContain('label: "店铺话题规则"');
    expect(campaignsPage).toContain("canManage={canManageBusiness}");
  });
});
