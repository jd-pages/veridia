export const AUTH_MODES = ["LOCAL", "DUAL", "CENTRAL"] as const;

export type AuthMode = (typeof AUTH_MODES)[number];

export const CENTRAL_FOUNDATION_EFFECTIVE_AUTH_MODE: AuthMode = "LOCAL";

export function normalizeAuthMode(value: unknown): AuthMode {
  return AUTH_MODES.includes(value as AuthMode) ? (value as AuthMode) : "LOCAL";
}

export interface LocalUsageSyncDraft {
  date: string;
  localUserId: string;
  deviceId: string;
  softwareVersion: string;
  ruleVersion: string;
  taskCount: number;
  auditCount: number;
  passedCount: number;
  failedCount: number;
  reviewCount: number;
  nonSensitiveErrorCount: number;
}
