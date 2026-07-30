import bcrypt from "bcryptjs";
import { LOCAL_ACCOUNT_ROLES, type LocalAccountRole } from "./types";

const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{2,31}$/u;

export function normalizeUsername(value: string) {
  return value.trim().normalize("NFKC").toLowerCase();
}

export function validateUsername(value: string) {
  const trimmed = value.trim().normalize("NFKC");
  if (!USERNAME_PATTERN.test(trimmed)) {
    throw new Error(
      "用户名须为3至32位，以字母开头，且只能包含字母、数字、点、下划线和短横线",
    );
  }
  return trimmed;
}

export function validatePassword(value: string) {
  if (
    value.length < 8 ||
    !/[A-Za-z]/u.test(value) ||
    !/[0-9]/u.test(value)
  ) {
    throw new Error("密码至少8位，并且必须同时包含字母和数字");
  }
  return value;
}

export function validateRole(value: string): LocalAccountRole {
  if (!LOCAL_ACCOUNT_ROLES.includes(value as LocalAccountRole)) {
    throw new Error("账号角色无效");
  }
  return value as LocalAccountRole;
}

export function validatePasswordHash(value: string) {
  if (!/^\$2[aby]\$\d{2}\$/u.test(value)) {
    throw new Error("密码哈希格式无效");
  }
  if (bcrypt.getRounds(value) < 12) {
    throw new Error("密码哈希安全参数不足");
  }
  return value;
}

export function parseAccountDate(value: string | null, field: string) {
  if (value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field}无效`);
  return date;
}

export function effectiveAccountStatus(account: {
  status: string;
  expiresAt: Date | null;
}): "ACTIVE" | "DISABLED" | "EXPIRED" {
  if (account.status !== "ACTIVE") return "DISABLED";
  if (account.expiresAt && account.expiresAt.getTime() <= Date.now()) {
    return "EXPIRED";
  }
  return "ACTIVE";
}
