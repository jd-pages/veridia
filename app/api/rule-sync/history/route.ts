import { ok, requireApiUser } from "@/lib/api";
import { prisma } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/permissions";

export async function GET() {
  const user = await requireApiUser(SYSTEM_ADMIN_ROLES);
  if (user instanceof Response) return user;
  return ok(
    await prisma.ruleSyncHistory.findMany({
      take: 50,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        ruleVersion: true,
        schemaVersion: true,
        source: true,
        status: true,
        errorCode: true,
        message: true,
        startedAt: true,
        completedAt: true,
      },
    }),
  );
}
