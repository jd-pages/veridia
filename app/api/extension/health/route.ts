import {
  extensionFail,
  extensionOk,
  extensionOptions,
  hasValidExtensionToken,
} from "@/lib/extension-api";

export async function OPTIONS() {
  return extensionOptions();
}

export async function GET(request: Request) {
  if (!(await hasValidExtensionToken(request))) {
    return extensionFail("插件提交令牌无效", "INVALID_TOKEN", 401);
  }

  return extensionOk({
    status: "ok",
    service: "xiaohongshu-note-auditor",
  });
}
