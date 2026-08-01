import { prisma } from "@/lib/db";
import { ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";

export const GET = withApiErrorBoundary(async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  return ok(
    await prisma.importRecord.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  );
}, "读取导入记录");
