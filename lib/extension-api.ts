import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Extension-Token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Private-Network": "true",
  "Cache-Control": "no-store",
} as const;

export function extensionOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

export function extensionOk<T>(data: T, status = 200) {
  return NextResponse.json(
    { success: true, data },
    { status, headers: corsHeaders },
  );
}

export function extensionFail(error: string, code: string, status = 400) {
  return NextResponse.json(
    { success: false, error, code },
    { status, headers: corsHeaders },
  );
}

export async function hasValidExtensionToken(request: Request) {
  const configured = await prisma.systemSetting.findUnique({
    where: { key: "EXTENSION_TOKEN" },
    select: { value: true },
  });
  const expectedToken =
    process.env.EXTENSION_TOKEN?.trim() || configured?.value?.trim();
  const suppliedToken = request.headers.get("x-extension-token");
  return Boolean(expectedToken && suppliedToken === expectedToken);
}
