import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { removeTemporaryDirectoryWithRetry } from "../helpers/remove-temporary-directory";

it("奖励档位migration保留历史结果与raw null，仅物化旧基础门槛精确predicate", async () => {
  const migration = "202609300001_campaign_interaction_reward_tiers";
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-reward-migration-"));
  const isolatedPrisma = path.join(temporaryRoot, "prisma");
  const migrationRoot = path.join(isolatedPrisma, "migrations");
  fs.mkdirSync(migrationRoot, { recursive: true });
  const schema = path.join(isolatedPrisma, "schema.prisma");
  fs.copyFileSync(path.resolve("prisma/schema.prisma"), schema);
  for (const entry of fs.readdirSync(path.resolve("prisma/migrations"), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name < migration) {
      fs.cpSync(path.resolve("prisma/migrations", entry.name), path.join(migrationRoot, entry.name), { recursive: true });
    }
  }
  const databasePath = path.join(temporaryRoot, "legacy.db");
  fs.writeFileSync(databasePath, "");
  const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
  const migrate = () => execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "migrate", "deploy", "--schema", schema], {
    env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe", windowsHide: true, timeout: 120_000,
  });
  let db: PrismaClient | undefined;
  try {
    migrate();
    db = new PrismaClient({ datasourceUrl: databaseUrl });
    await db.$executeRaw`INSERT INTO products (id,name,brandName,updatedAt) VALUES ('reward-k','旧佳贝','佳贝艾特',CURRENT_TIMESTAMP),('reward-d','旧达能','达能',CURRENT_TIMESTAMP)`;
    for (const [id, productId, name, channel, month] of [
      ["reward-legacy", "reward-k", "佳贝艾特2026年8月小红书种草审核", "XIAOHONGSHU", "2026-08"],
      ["reward-join", "reward-d", "佳贝艾特2026年8月小红书种草审核", "XIAOHONGSHU", "2026-07"],
      ["reward-september", "reward-k", "佳贝艾特2026年9月小红书种草审核", "XIAOHONGSHU", "2026-09"],
      ["reward-douyin", "reward-k", "佳贝艾特2026年8月小红书种草审核", "DOUYIN", "2026-06"],
      ["reward-foreign", "reward-d", "佳贝艾特2026年8月小红书种草审核", "XIAOHONGSHU", "2026-05"],
    ]) {
      await db.$executeRaw`INSERT INTO campaigns (id,productId,name,month,contentChannel,startDate,endDate,updatedAt) VALUES (${id},${productId},${name},${month},${channel},CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`;
    }
    await db.$executeRaw`INSERT INTO campaign_products (id,campaignId,productId,sortOrder) VALUES ('reward-cp','reward-join','reward-k',0)`;
    await db.$executeRaw`INSERT INTO audit_tasks (id,url,normalizedUrl,productId,campaignId,updatedAt) VALUES ('reward-t','https://example.invalid/reward','https://example.invalid/reward','reward-k','reward-legacy',CURRENT_TIMESTAMP)`;
    await db.$executeRaw`INSERT INTO note_records (id,url,body,updatedAt) VALUES ('reward-n','https://example.invalid/reward','历史正文',CURRENT_TIMESTAMP)`;
    await db.$executeRaw`INSERT INTO extraction_records (id,auditTaskId,noteId,adapterName,adapterVersion,pageStatus,rawData) VALUES ('reward-e','reward-t','reward-n','legacy','1','NORMAL','{"likeCount":null,"commentCount":3,"favoriteCount":null}')`;
    await db.$executeRaw`INSERT INTO audit_results (id,auditTaskId,noteId,ruleVersion,ruleSnapshot,pageStatus,bodyStatus,imageCount,imageCompliant,topicsCompliant,clickableCompliant,autoStatus,likeCount,commentCount,favoriteCount) VALUES ('reward-r','reward-t','reward-n',1,'{"basicRewardRequired":true}', 'NORMAL','PRESENT',2,true,true,true,'FAILED',NULL,3,NULL)`;
    const before = await db.$queryRaw`SELECT * FROM audit_results WHERE id='reward-r'`;
    const extractionBefore = await db.$queryRaw`SELECT * FROM extraction_records WHERE id='reward-e'`;
    await db.$disconnect();
    fs.cpSync(path.resolve("prisma/migrations", migration), path.join(migrationRoot, migration), { recursive: true });
    migrate();
    db = new PrismaClient({ datasourceUrl: databaseUrl });
    expect(await db.$queryRaw`SELECT * FROM audit_results WHERE id='reward-r'`).toEqual(before);
    expect(await db.$queryRaw`SELECT * FROM extraction_records WHERE id='reward-e'`).toEqual(extractionBefore);
    const campaigns = await db.campaign.findMany({ where: { id: { startsWith: "reward-" } }, orderBy: { id: "asc" }, include: { interactionRewardTiers: true } });
    expect(campaigns.filter((campaign) => campaign.basicRewardRequired).map((campaign) => campaign.id).sort())
      .toEqual(["reward-join", "reward-legacy"]);
    expect(campaigns.every((campaign) => campaign.rewardMode === "LEGACY" && campaign.baseRewardAmount === 0 && campaign.interactionRewardTiers.length === 0)).toBe(true);
    await db.campaignInteractionRewardTier.create({ data: { campaignId: "reward-legacy", threshold: 10, amount: 20 } });
    await expect(db.campaignInteractionRewardTier.create({ data: { campaignId: "reward-legacy", threshold: 10, amount: 50 } })).rejects.toThrow();
    await expect(db.campaignInteractionRewardTier.create({ data: { campaignId: "missing", threshold: 40, amount: 50 } })).rejects.toThrow();
    const models = (schemaPath: string) => fs.readFileSync(schemaPath, "utf8").match(/model\s+\w+\s*\{[\s\S]*?\n\}/gu);
    expect(models(path.resolve("prisma/schema.postgresql.prisma"))).toEqual(models(path.resolve("prisma/schema.prisma")));
  } finally {
    await db?.$disconnect();
    if (path.dirname(path.resolve(temporaryRoot)) !== path.resolve(os.tmpdir()) || !path.basename(temporaryRoot).startsWith("veridia-reward-migration-")) {
      throw new Error("拒绝清理非奖励测试临时目录");
    }
    await removeTemporaryDirectoryWithRetry(temporaryRoot);
  }
}, 120_000);
