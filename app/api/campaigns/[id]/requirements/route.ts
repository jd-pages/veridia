import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser } from "@/lib/api";
import { getAuditContext } from "@/lib/audit-service";
import { PRODUCT_STAGES } from "@/lib/rule-import";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const productId = searchParams.get("productId");
  const stage = searchParams.get("stage");
  if (!productId) return fail("请选择产品");
  try {
    const [context, product] = await Promise.all([
      getAuditContext(productId, id, stage),
      prisma.product.findUnique({
        where: { id: productId },
        include: { aliases: true },
      }),
    ]);
    return ok({
      context,
      product,
      stages: PRODUCT_STAGES,
      contentDirection: product?.contentDirection || null,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "无法加载审核要求");
  }
}
