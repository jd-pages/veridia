import { timingSafeEqual } from "node:crypto";
import { isLocalPreviewMode } from "@/lib/local-preview-mode";

const bootstrapState = globalThis as typeof globalThis & {
  veridiaConsumedPreviewNonces?: Set<string>;
};

export function consumePreviewBootstrapNonce(value: unknown) {
  if (!isLocalPreviewMode()) return false;
  const expected = process.env.VERIDIA_PREVIEW_BOOTSTRAP_NONCE || "";
  const expiresAt = Number(process.env.VERIDIA_PREVIEW_BOOTSTRAP_EXPIRES_AT);
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(expected) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value) ||
    value.length !== expected.length ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    !timingSafeEqual(Buffer.from(value), Buffer.from(expected))
  ) return false;
  const consumed = bootstrapState.veridiaConsumedPreviewNonces ??= new Set();
  if (consumed.has(expected)) return false;
  // Consume synchronously before any session creation work can yield.
  consumed.add(expected);
  return true;
}
