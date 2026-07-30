import { getSession } from "@/lib/auth";
import { ok } from "@/lib/api";
import { ensureLocalRuntime } from "@/lib/local-runtime";

export async function GET() {
  return ok((await getSession()) || (await ensureLocalRuntime()));
}
