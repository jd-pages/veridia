import { ok, requireApiUser } from "@/lib/api";
import { prisma } from "@/lib/db";

export async function GET() {
  const user = await requireApiUser(["ADMIN"]);
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
