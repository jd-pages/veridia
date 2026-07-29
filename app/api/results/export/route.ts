import { prisma } from "@/lib/db";
import { buildResultsWorkbook, excelResponse } from "@/lib/excel";
import { requireApiUser } from "@/lib/api";

export async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { searchParams } = new URL(request.url);
  const productId = searchParams.get("productId") || undefined;
  const campaignId = searchParams.get("campaignId") || undefined;
  const month = searchParams.get("month") || undefined;
  const status = searchParams.get("status") || undefined;
  const imageStatus = searchParams.get("imageStatus") || undefined;
  const reason = searchParams.get("reason")?.trim() || undefined;
  const keyword = searchParams.get("keyword")?.trim() || undefined;
  const rows = await prisma.auditResult.findMany({
    where: {
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
            ],
          }
        : {}),
    },
    include: {
      note: {
        include: {
          topics: {
            select: {
              displayText: true,
              isClickable: true,
              isLinkElement: true,
              hasHref: true,
              href: true,
              styleFeature: true,
            },
          },
        },
      },
      task: { include: { product: true, campaign: true } },
      manualReviews: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { auditedAt: "desc" },
  });
  const buffer = await buildResultsWorkbook(rows);
  return excelResponse(
    buffer,
    `小红书审核结果_${new Date().toISOString().slice(0, 10)}.xlsx`,
  );
}
