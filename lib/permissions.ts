import type { LocalAccountRole } from "@/lib/accounts/types";

export const BUSINESS_ROLES = ["ADMIN", "OPERATOR"] as const satisfies readonly LocalAccountRole[];
export const SYSTEM_ADMIN_ROLES = ["ADMIN"] as const satisfies readonly LocalAccountRole[];

export function canAccessBusiness(
  role: LocalAccountRole | null | undefined,
) {
  return role === "ADMIN" || role === "OPERATOR";
}

export function canAccessSystemSettings(
  role: LocalAccountRole | null | undefined,
) {
  return role === "ADMIN";
}
