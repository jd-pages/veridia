import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyRulePayload, exportCurrentRulePayload } from "@/lib/rules/package";
import { legacyBasicRewardRequired } from "@/lib/campaign-reward-config";
import { assertRulePackageCompatibleWithApp } from "@/lib/rules/version-contract";
import { removeTemporaryDirectoryWithRetry } from "../helpers/remove-temporary-directory";

let temporaryRoot = "";
let source: PrismaClient;
let target: PrismaClient;
beforeAll(async () => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-reward-package-"));
  execFileSync(process.execPath, [path.resolve("scripts/testing/e2e-database-template.mjs")], {
    cwd: process.cwd(), env: process.env, windowsHide: true, stdio: "pipe",
  });
  const clients = ["source", "target"].map((name) => {
    const databasePath = path.join(temporaryRoot, `${name}.db`);
    fs.copyFileSync(path.resolve(".playwright/e2e-template/baseline.db"), databasePath);
    fs.chmodSync(databasePath, 0o600);
    return new PrismaClient({ datasourceUrl: `file:${databasePath.replaceAll("\\", "/")}` });
  });
  [source, target] = clients;
  await source.campaignInteractionRewardTier.deleteMany();
  const campaigns = await source.campaign.findMany({ include: { product: true, products: { include: { product: true } } } });
  for (const campaign of campaigns) {
    await source.campaign.update({ where: { id: campaign.id }, data: { rewardMode: "LEGACY", baseRewardAmount: 0,
      interactionRewardEnabled: false, interactionRewardThreshold: 0,
      basicRewardRequired: legacyBasicRewardRequired({ name: campaign.name, contentChannel: campaign.contentChannel,
        brandNames: [campaign.product?.brandName || "", ...campaign.products.map((link) => link.product.brandName)] }),
    } });
  }
}, 30_000);
afterAll(async () => {
  await source?.$disconnect();
  await target?.$disconnect();
  if (temporaryRoot) await removeTemporaryDirectoryWithRetry(temporaryRoot);
}, 30_000);

describe.sequential("Reward package feature-driven compatibility", () => {
  it("canonical LEGACY导出min17，旧单档奖励min22，不含新四字段且旧往返可用", async () => {
    const canonical = await exportCurrentRulePayload({ minimumAppVersion: "1.1.17", ruleVersion: "rules-2026.09.30.170" }, source);
    expect(canonical.minimumAppVersion).toBe("1.1.17");
    for (const campaign of canonical.campaigns) {
      for (const field of ["rewardMode", "basicRewardRequired", "baseRewardAmount", "interactionRewardTiers"]) {
        expect(Object.hasOwn(campaign, field), field).toBe(false);
      }
    }
    await expect(applyRulePayload(canonical, "GITHUB", target)).resolves.toBeDefined();
    const selected = await source.campaign.findFirstOrThrow({ where: { deletedAt: null } });
    await source.campaign.update({ where: { id: selected.id }, data: { interactionRewardEnabled: true, interactionRewardThreshold: 10 } });
    const single = await exportCurrentRulePayload({ minimumAppVersion: "1.1.17", ruleVersion: "rules-2026.09.30.220" }, source);
    expect(single.minimumAppVersion).toBe("1.1.22");
    expect(single.campaigns.every((campaign) => !Object.hasOwn(campaign, "rewardMode"))).toBe(true);
    await expect(applyRulePayload(single, "GITHUB", target)).resolves.toBeDefined();
    expect(await target.campaign.findFirstOrThrow({ where: { name: selected.name, month: selected.month } }))
      .toMatchObject({ interactionRewardEnabled: true, interactionRewardThreshold: 10 });
    await source.campaign.update({ where: { id: selected.id }, data: { interactionRewardEnabled: false, interactionRewardThreshold: 0 } });
  });

  it("LEGACY显式override与阶梯模式导出min41完整配置，不放宽应用版本guard", async () => {
    const selected = await source.campaign.findFirstOrThrow({ where: { deletedAt: null } });
    await source.campaign.update({ where: { id: selected.id }, data: { basicRewardRequired: !selected.basicRewardRequired } });
    const override = await exportCurrentRulePayload({ minimumAppVersion: "1.1.17" }, source);
    expect(override.minimumAppVersion).toBe("1.1.41");
    expect(override.campaigns.find((campaign) => campaign.name === selected.name && campaign.month === selected.month))
      .toMatchObject({ rewardMode: "LEGACY", basicRewardRequired: !selected.basicRewardRequired, baseRewardAmount: 0, interactionRewardTiers: [] });
    await source.campaign.update({ where: { id: selected.id }, data: { rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS",
      baseRewardAmount: 50, interactionRewardTiers: { create: [{ threshold: 10, amount: 20 }, { threshold: 40, amount: 50 }] } } });
    const tiered = await exportCurrentRulePayload({ minimumAppVersion: "1.1.17" }, source);
    expect(tiered.minimumAppVersion).toBe("1.1.41");
    expect(tiered.campaigns.find((campaign) => campaign.name === selected.name && campaign.month === selected.month))
      .toMatchObject({ rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS", baseRewardAmount: 50,
        interactionRewardTiers: [{ threshold: 10, amount: 20 }, { threshold: 40, amount: 50 }] });
    expect(() => assertRulePackageCompatibleWithApp("1.1.40", tiered.minimumAppVersion)).toThrow("最低兼容版本");
    expect(() => assertRulePackageCompatibleWithApp("1.1.41", tiered.minimumAppVersion)).not.toThrow();
    await source.campaignInteractionRewardTier.deleteMany({ where: { campaignId: selected.id } });
    await source.campaign.update({ where: { id: selected.id }, data: { rewardMode: "LEGACY", baseRewardAmount: 0, basicRewardRequired: selected.basicRewardRequired } });
  });

  it("旧包应用已有阶梯活动时保留rewardMode/base/tiers与历史snapshot", async () => {
    const oldPayload = await exportCurrentRulePayload({ minimumAppVersion: "1.1.17", ruleVersion: "rules-2026.09.30.171" }, source);
    const selected = oldPayload.campaigns[0];
    const existing = await target.campaign.findFirstOrThrow({ where: { name: selected.name, month: selected.month } });
    await target.campaign.update({ where: { id: existing.id }, data: { rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS",
      basicRewardRequired: true, baseRewardAmount: 50, interactionRewardTiers: { deleteMany: {}, create: [
        { threshold: 10, amount: 20, sortOrder: 0 }, { threshold: 40, amount: 50, sortOrder: 1 },
      ] } } });
    const historical = await target.auditResult.findMany({ select: { id: true, ruleSnapshot: true, likeCount: true, commentCount: true, favoriteCount: true }, orderBy: { id: "asc" } });
    await applyRulePayload(oldPayload, "GITHUB", target);
    expect(await target.campaign.findUniqueOrThrow({ where: { id: existing.id }, include: { interactionRewardTiers: { orderBy: { threshold: "asc" } } } }))
      .toMatchObject({ rewardMode: "CONTENT_BASE_PLUS_INTERACTION_TIERS", basicRewardRequired: true, baseRewardAmount: 50,
        interactionRewardTiers: [{ threshold: 10, amount: 20 }, { threshold: 40, amount: 50 }] });
    expect(await target.auditResult.findMany({ select: { id: true, ruleSnapshot: true, likeCount: true, commentCount: true, favoriteCount: true }, orderBy: { id: "asc" } }))
      .toEqual(historical);
  });
});
