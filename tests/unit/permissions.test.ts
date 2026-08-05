import { describe, expect, it } from "vitest";
import {
  BUSINESS_ROLES,
  SYSTEM_ADMIN_ROLES,
  canAccessBusiness,
  canAccessSystemSettings,
} from "@/lib/permissions";

describe("账号角色权限", () => {
  it("ADMIN 和 OPERATOR 拥有相同业务权限", () => {
    expect(BUSINESS_ROLES).toEqual(["ADMIN", "OPERATOR"]);
    expect(canAccessBusiness("ADMIN")).toBe(true);
    expect(canAccessBusiness("OPERATOR")).toBe(true);
    expect(canAccessBusiness("VIEWER")).toBe(false);
  });

  it("ADMIN 和 OPERATOR 拥有相同系统设置权限", () => {
    expect(SYSTEM_ADMIN_ROLES).toEqual(["ADMIN", "OPERATOR"]);
    expect(canAccessSystemSettings("ADMIN")).toBe(true);
    expect(canAccessSystemSettings("OPERATOR")).toBe(true);
    expect(canAccessSystemSettings("VIEWER")).toBe(false);
  });
});
