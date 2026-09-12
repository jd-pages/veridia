import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import builtinRules from "@/rules/default-rules.json";
import {
  resolveTopicRuleOwnership,
  topicRuleSemanticKey,
} from "@/lib/topic-rule-model";

const DEFAULT_DATABASE = "E:/veridi/shuju/data/veridia.db";
const DEFAULT_OUTPUT = path.resolve(
  process.cwd(),
  ".playwright/topic-rule-model-v1.1.25-classification.json",
);

function argument(name: string, fallback: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

async function sha256(filePath: string) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex").toUpperCase();
}

function emptyCounts() {
  return { GLOBAL: 0, PRODUCT: 0, CAMPAIGN: 0, UNRESOLVED: 0 };
}

async function main() {
  const databasePath = path.resolve(argument("database", DEFAULT_DATABASE));
  const outputPath = path.resolve(argument("output", DEFAULT_OUTPUT));
  const before = {
    size: (await fs.stat(databasePath)).size,
    sha256: await sha256(databasePath),
  };
  const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}?mode=ro`;
  const database = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const [rules, campaigns] = await Promise.all([
      database.topicRule.findMany({
        where: { status: "ACTIVE" },
        include: {
          product: { select: { id: true, name: true, brandName: true } },
          campaign: {
            include: {
              product: { select: { id: true, name: true, brandName: true } },
              products: {
                select: {
                  productId: true,
                  product: { select: { id: true, name: true, brandName: true } },
                },
              },
            },
          },
        },
        orderBy: [{ brandName: "asc" }, { id: "asc" }],
      }),
      database.campaign.findMany({
        where: { deletedAt: null, status: "ACTIVE" },
        include: {
          product: { select: { id: true, name: true, brandName: true } },
          products: {
            select: {
              productId: true,
              product: { select: { id: true, name: true, brandName: true } },
            },
          },
        },
        orderBy: [{ contentChannel: "asc" }, { month: "asc" }, { id: "asc" }],
      }),
    ]);
    const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
    const candidates = rules.map((rule) => {
      const resolution = resolveTopicRuleOwnership(rule, campaigns);
      const resolvedCampaign = resolution.campaignId
        ? campaignById.get(resolution.campaignId) || null
        : null;
      return {
        ruleId: rule.id,
        topic: rule.topic,
        oldScope: rule.scope,
        newScope: resolution.scope,
        brand: rule.brandName,
        product: rule.product
          ? { id: rule.product.id, name: rule.product.name }
          : null,
        campaign: resolvedCampaign
          ? { id: resolvedCampaign.id, name: resolvedCampaign.name, month: resolvedCampaign.month }
          : rule.campaign
            ? { id: rule.campaign.id, name: rule.campaign.name, month: rule.campaign.month }
            : null,
        topicCategory: rule.topicCategory,
        applicableStage: rule.applicableStage,
        milkType: rule.milkType,
        contentChannel: rule.contentChannel,
        status: resolution.status,
        resolutionBasis: resolution.resolutionBasis,
        candidateCampaigns: resolution.candidateCampaignIds.map((id) => {
          const campaign = campaignById.get(id);
          return { id, name: campaign?.name || null, month: campaign?.month || null };
        }),
        semanticKey: topicRuleSemanticKey({
          ...rule,
          scope: resolution.scope,
          productId: resolution.productId,
          campaignId: resolution.campaignId,
        }),
      };
    });
    const brandNames = [...new Set(candidates.map((item) => item.brand || "UNBRANDED"))];
    const byBrand = Object.fromEntries(brandNames.map((brandName) => {
      const brandRules = candidates.filter((item) => (item.brand || "UNBRANDED") === brandName);
      const beforeCounts = emptyCounts();
      const afterCounts = emptyCounts();
      for (const rule of brandRules) {
        if (rule.oldScope in beforeCounts) {
          beforeCounts[rule.oldScope as "GLOBAL" | "PRODUCT" | "CAMPAIGN"] += 1;
        }
        if (["VALID", "DETERMINISTIC_BINDING_CANDIDATE"].includes(rule.status)) {
          afterCounts[rule.newScope] += 1;
        } else {
          afterCounts.UNRESOLVED += 1;
        }
      }
      return [brandName, { before: beforeCounts, after: afterCounts }];
    }));
    const semanticGroups = new Map<string, string[]>();
    for (const candidate of candidates) {
      if (candidate.status !== "VALID") continue;
      const ids = semanticGroups.get(candidate.semanticKey) || [];
      ids.push(candidate.ruleId);
      semanticGroups.set(candidate.semanticKey, ids);
    }
    const semanticDuplicates = [...semanticGroups.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([semanticKey, ruleIds]) => ({ semanticKey, ruleIds }));
    const defaultCounts = emptyCounts();
    for (const rule of builtinRules.topicRules) {
      if (rule.scope in defaultCounts) {
        defaultCounts[rule.scope as "GLOBAL" | "PRODUCT" | "CAMPAIGN"] += 1;
      }
      if (rule.notes === "LEGACY_UNRESOLVED_ACTIVITY_BINDING") {
        defaultCounts.UNRESOLVED += 1;
      }
    }
    await database.$disconnect();
    const after = {
      size: (await fs.stat(databasePath)).size,
      sha256: await sha256(databasePath),
    };
    if (before.size !== after.size || before.sha256 !== after.sha256) {
      throw new Error("正式数据库在只读分类期间发生变化");
    }
    const report = {
      generatedAt: new Date().toISOString(),
      databasePath,
      databaseReadOnly: true,
      databaseIdentityBefore: before,
      databaseIdentityAfter: after,
      databaseMutation: 0,
      totals: {
        activeRules: candidates.length,
        unresolved: candidates.filter((item) => ![
          "VALID",
          "DETERMINISTIC_BINDING_CANDIDATE",
        ].includes(item.status)).length,
        deterministicBindingCandidates: candidates.filter(
          (item) => item.status === "DETERMINISTIC_BINDING_CANDIDATE",
        ).length,
      },
      byBrand,
      danone: candidates.filter((item) => item.brand === "达能"),
      wyeth: candidates.filter((item) => item.brand === "惠氏"),
      unresolved: candidates.filter((item) => item.status !== "VALID"),
      semanticDuplicates,
      defaultRulesPreview: {
        source: "rules/default-rules.json (also used by isolated seed)",
        counts: defaultCounts,
      },
      candidates,
    };
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ outputPath, totals: report.totals, byBrand }, null, 2)}\n`);
  } finally {
    await database.$disconnect();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
