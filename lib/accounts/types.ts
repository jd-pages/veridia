export const LOCAL_ACCOUNT_ROLES = ["ADMIN", "OPERATOR", "VIEWER"] as const;
export type LocalAccountRole = (typeof LOCAL_ACCOUNT_ROLES)[number];

export const ACCOUNT_CODE_KINDS = [
  "ACCOUNT_ACTIVATION",
  "PASSWORD_RESET",
  "ACCOUNT_UPDATE",
] as const;
export type AccountCodeKind = (typeof ACCOUNT_CODE_KINDS)[number];

export interface AccountCodeBase {
  schemaVersion: 1 | 2;
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
  /**
   * VRD1 legacy activation codes carry the initial password hash.
   * VRD2 activation codes intentionally omit it and require local password
   * setup after signature verification.
   */
  passwordHash?: string;
  notes?: string;
}

export interface PasswordResetPayload extends AccountCodeBase {
  schemaVersion: 1;
  kind: "PASSWORD_RESET";
  passwordHash: string;
  notes?: string;
}

export interface AccountUpdatePayload extends AccountCodeBase {
  schemaVersion: 1;
  kind: "ACCOUNT_UPDATE";
  displayName: string;
  role: LocalAccountRole;
  notes?: string;
}

export type AccountCodePayload =
  | AccountActivationPayload
  | PasswordResetPayload
  | AccountUpdatePayload;

export type CompactAccountRole = "A" | "O" | "V";

export interface CompactAccountActivationPayload {
  v: 2;
  k: "a";
  av: number;
  i: string;
  u: string;
  n: string;
  r: CompactAccountRole;
  ia: number;
  ea?: number;
}

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
