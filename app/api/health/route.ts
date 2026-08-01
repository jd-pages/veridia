import { NextResponse } from "next/server";
import packageJson from "@/package.json";

export const dynamic = "force-dynamic";

export function GET() {
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
