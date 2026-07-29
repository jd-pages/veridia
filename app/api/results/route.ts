import { prisma } from "@/lib/db";
import { ok, requireApiUser } from "@/lib/api";

export async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { searchParams } = new URL(request.url);
  const page = Math.max(Number(searchParams.get("page") || 1), 1);
  const pageSize = Math.min(Math.max(Number(searchParams.get("pageSize") || 20), 1), 100);
  const productId = searchParams.get("productId") || undefined;
  const campaignId = searchParams.get("campaignId") || undefined;
  const month = searchParams.get("month") || undefined;
  const status = searchParams.get("status") || undefined;
  const imageStatus = searchParams.get("imageStatus") || undefined;
  const keyword = searchParams.get("keyword")?.trim() || undefined;
  const reason = searchParams.get("reason")?.trim() || undefined;
  const where = {
    ...(status ? { autoStatus: status } : {}),
    ...(imageStatus ? { imageStatus } : {}),
    ...(reason ? { failureReasons: { contains: reason } } : {}),
    task: {
      ...(productId ? { productId } : {}),
      ...(campaignId ? { campaignId } : {}),
      ...(month ? { campaign: { month } } : {}),
    },
    ...(keyword
      ? {
          OR: [
            { note: { title: { contains: keyword } } },
            { note: { body: { contains: keyword } } },
            { note: { url: { contains: keyword } } },
            { note: { platformNoteId: { contains: keyword } } },
          ],
        }
      : {}),
  };
  const [total, items] = await prisma.$transaction([
    prisma.auditResult.count({ where }),
    prisma.auditResult.findMany({
      where,
      include: {
        note: { include: { topics: true } },
        task: { include: { product: true, campaign: true } },
        manualReviews: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { reviewer: { select: { displayName: true } } },
        },
      },
      orderBy: { auditedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  return ok({ total, page, pageSize, items });
}
