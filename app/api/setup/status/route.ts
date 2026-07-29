import { ok } from "@/lib/api";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const userCount = await prisma.user.count();
  return ok({
    initialized: userCount > 0,
    dataDirectory: process.env.VERIDIA_DATA_DIR || "本地数据目录",
    desktop: process.env.VERIDIA_DESKTOP === "true",
    aiEnabled: false,
  });
}
