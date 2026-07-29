import { PrismaClient } from "@prisma/client";
import {
  normalizeProductStageTopicValue,
  productStageTopicLabel,
} from "../lib/product-stage";

const prisma = new PrismaClient();

async function main() {
  const rules = await prisma.topicRule.findMany({
    where: {
      topicCategory: "PRODUCT_STAGE",
      applicableStage: { not: null },
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const grouped = new Map<string, typeof rules>();
  const unrecognized: string[] = [];

  for (const rule of rules) {
    const normalized = normalizeProductStageTopicValue(rule.applicableStage);
    if (!normalized) {
      unrecognized.push(
        `${rule.id}:${rule.applicableStage || "空"}:${rule.topic}`,
      );
      continue;
    }
    const key = [
      rule.campaignId || "*",
      rule.productId || "*",
      normalized,
      rule.topic,
      rule.ruleType,
      rule.status,
    ].join("|");
    grouped.set(key, [...(grouped.get(key) || []), rule]);
  }

  let updated = 0;
  let removedDuplicates = 0;
  await prisma.$transaction(async (tx) => {
    for (const entries of grouped.values()) {
      const [keeper, ...duplicates] = entries;
      const normalized = normalizeProductStageTopicValue(
        keeper.applicableStage,
      );
      if (!normalized) continue;
      if (keeper.applicableStage !== normalized) {
        await tx.topicRule.update({
          where: { id: keeper.id },
          data: { applicableStage: normalized },
        });
        updated += 1;
      }
      if (duplicates.length) {
        await tx.topicRule.deleteMany({
          where: { id: { in: duplicates.map((rule) => rule.id) } },
        });
        removedDuplicates += duplicates.length;
      }
    }
  });

  const groupCounts = await prisma.topicRule.groupBy({
    by: ["applicableStage"],
    where: {
      topicCategory: "PRODUCT_STAGE",
      applicableStage: { not: null },
    },
    _count: { _all: true },
  });

  console.log(
    JSON.stringify(
      {
        updated,
        removedDuplicates,
        unrecognized,
        groups: groupCounts.map((item) => ({
          value: item.applicableStage,
          label: productStageTopicLabel(item.applicableStage),
          count: item._count._all,
        })),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "迁移失败");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
