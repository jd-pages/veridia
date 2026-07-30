import { ok, requireApiUser } from "@/lib/api";
import { prisma } from "@/lib/db";
import { ensureBuiltinRules } from "@/lib/rules/sync";

export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  await ensureBuiltinRules();
  const groups = await prisma.ruleStageGroup.findMany({
    orderBy: { sortOrder: "asc" },
  });
  return ok(
    groups.map((group) => ({
      ...group,
      canonicalStages: JSON.parse(group.canonicalStages) as string[],
      bodyTerms: JSON.parse(group.bodyTerms) as string[],
    })),
  );
}
