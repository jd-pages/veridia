import { NextResponse } from "next/server";
import packageJson from "@/package.json";
import { activateRetentionRecheckWorkflow } from "@/lib/automation/retention-recheck";
import "@/lib/automation/queue";

export const dynamic = "force-dynamic";

export function GET() {
  if (process.env.VERIDIA_DESKTOP === "true") {
    void activateRetentionRecheckWorkflow().catch((error) => {
      console.error(
        "[公开留存复查] 启动恢复失败",
        error instanceof Error ? error.message : "未知错误",
      );
    });
  }
  return NextResponse.json(
    {
      ok: true,
      version: process.env.VERIDIA_APP_VERSION || packageJson.version,
      service: "VERIDIA",
      desktop: process.env.VERIDIA_DESKTOP === "true",
      instanceId: process.env.VERIDIA_DESKTOP_INSTANCE_ID || null,
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
