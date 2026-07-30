import { ok } from "@/lib/api";
import { establishLocalSession } from "@/lib/local-runtime";

export async function POST() {
  return ok(await establishLocalSession());
}
