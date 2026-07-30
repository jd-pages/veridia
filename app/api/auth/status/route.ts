import { ok } from "@/lib/api";
import { activatedAccountCount } from "@/lib/accounts/service";
import { accountSigningPublicKeyPath } from "@/lib/accounts/codes";

export async function GET() {
  return ok({
    activatedAccountCount: await activatedAccountCount(),
    canVerifyActivation: Boolean(accountSigningPublicKeyPath()),
  });
}
