export const LOCAL_ACCOUNT_ROLES = ["ADMIN", "OPERATOR", "VIEWER"] as const;
export type LocalAccountRole = (typeof LOCAL_ACCOUNT_ROLES)[number];

export const ACCOUNT_CODE_KINDS = [
  "ACCOUNT_ACTIVATION",
  "PASSWORD_RESET",
  "ACCOUNT_UPDATE",
] as const;
export type AccountCodeKind = (typeof ACCOUNT_CODE_KINDS)[number];

export interface AccountCodeBase {
  schemaVersion: 1;
  kind: AccountCodeKind;
  authorizationVersion: number;
  accountId: string;
  username: string;
  issuedAt: string;
  expiresAt: string | null;
  issuer: string;
}

export interface AccountActivationPayload extends AccountCodeBase {
  kind: "ACCOUNT_ACTIVATION";
  displayName: string;
  role: LocalAccountRole;
  passwordHash: string;
  notes?: string;
}

export interface PasswordResetPayload extends AccountCodeBase {
  kind: "PASSWORD_RESET";
  passwordHash: string;
  notes?: string;
}

export interface AccountUpdatePayload extends AccountCodeBase {
  kind: "ACCOUNT_UPDATE";
  displayName: string;
  role: LocalAccountRole;
  notes?: string;
}

export type AccountCodePayload =
  | AccountActivationPayload
  | PasswordResetPayload
  | AccountUpdatePayload;

export interface PublicAccount {
  id: string;
  accountId: string;
  username: string;
  displayName: string;
  role: LocalAccountRole;
  status: "ACTIVE" | "DISABLED" | "EXPIRED";
  issuedAt: Date | null;
  expiresAt: Date | null;
  activatedAt: Date | null;
  lastLocalLoginAt: Date | null;
}
