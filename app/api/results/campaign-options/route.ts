import { ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { prisma } from "@/lib/db";

export const GET = withApiErrorBoundary(async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const productId = new URL(request.url).searchParams.get("productId")?.trim();
  const tasks = await prisma.auditTask.findMany({
    where: {
      ...(productId ? { productId } : {}),
      auditResults: { some: {} },
    },
    select: {
      productId: true,
      campaign: {
        select: { id: true, name: true, month: true },
      },
    },
    orderBy: [{ campaign: { startDate: "desc" } }, { createdAt: "desc" }],
  });
  const campaigns = new Map<string, {
    id: string;
    name: string;
    month: string;
    productId: string;
  }>();
  for (const task of tasks) {
    if (!campaigns.has(task.campaign.id)) {
      campaigns.set(task.campaign.id, {
        ...task.campaign,
        productId: task.productId,
      });
    }
  }
  return ok([...campaigns.values()]);
}, "读取历史审核活动筛选项");
