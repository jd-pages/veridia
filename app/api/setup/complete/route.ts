import { fail, ok, requireApiUser } from "@/lib/api";
import { markSetupComplete } from "@/lib/local-runtime";

export async function POST() {
  try {
    const user = await requireApiUser();
    if (user instanceof Response) return user;
    await markSetupComplete();
    return ok({ completed: true });
  } catch {
    return fail("保存首次启动状态失败（SETUP_COMPLETE_FAILED）", 500);
  }
}
