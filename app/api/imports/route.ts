import { prisma } from "@/lib/db";
import { ok, requireApiUser } from "@/lib/api";

export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  return ok(
    await prisma.importRecord.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  );
}
