import { createSession } from "@/lib/auth";
import { fail, ok, withApiErrorBoundary } from "@/lib/api";
import { ensureLocalPreviewRuntime } from "@/lib/local-runtime";
import { consumePreviewBootstrapNonce } from "@/lib/preview-session-bootstrap";

export const POST = withApiErrorBoundary(async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!consumePreviewBootstrapNonce(body?.nonce)) {
    return fail("预览启动凭证无效或已使用，请重新启动本地预览。", 401, "UNAUTHENTICATED");
  }
  const user = await ensureLocalPreviewRuntime();
  if (!user) return fail("当前环境不支持本地预览登录。", 401, "UNAUTHENTICATED");
  await createSession(user);
  return ok({ restored: true });
}, "恢复本地预览登录");
