import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  token: undefined as string | undefined,
  findSession: vi.fn(),
  revokeSession: vi.fn(),
  findUser: vi.fn(),
  createSession: vi.fn(),
  setCookie: vi.fn(),
  deleteCookie: vi.fn(),
  findProducts: vi.fn(),
  ensurePreview: vi.fn(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => fixture.token ? { value: fixture.token } : undefined,
    set: fixture.setCookie,
    delete: fixture.deleteCookie,
  }),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    localAuthSession: {
      findUnique: fixture.findSession,
      updateMany: fixture.revokeSession,
      create: fixture.createSession,
    },
    user: { findUniqueOrThrow: fixture.findUser },
    product: { findMany: fixture.findProducts },
  },
}));
vi.mock("@/lib/local-runtime", () => ({
  ensureLocalPreviewRuntime: fixture.ensurePreview,
}));

import { clearSession, createSession, getSession } from "@/lib/auth";
import { GET, POST } from "@/app/api/products/route";
import { consumePreviewBootstrapNonce } from "@/lib/preview-session-bootstrap";
import { POST as PREVIEW_BOOTSTRAP } from "@/app/api/auth/preview-bootstrap/route";

const require = createRequire(import.meta.url);
const { restoreDesktopSessionCookie, isTrustedSessionSender } = require(
  "../../desktop/session-bootstrap.cjs",
);
const adminToken = randomBytes(32).toString("base64url");
const viewerToken = randomBytes(32).toString("base64url");
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

function session(role = "ADMIN") {
  return {
    user: {
      id: role.toLowerCase(),
      accountId: `${role}-account`,
      username: role.toLowerCase(),
      displayName: role,
      role,
      status: "ACTIVE",
      authProvider: "LOCAL_ACTIVATION",
      expiresAt: null as Date | null,
      sessionVersion: 1,
    },
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null as Date | null,
    sessionVersion: 1,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  fixture.token = undefined;
  vi.stubEnv("VERIDIA_PERSISTENT_SESSION_TOKEN", adminToken);
  vi.stubEnv("VERIDIA_LOCAL_PREVIEW", "0");
  fixture.findSession.mockImplementation(async ({ where }) =>
    where.tokenHash === hash(adminToken) ? session() :
      where.tokenHash === hash(viewerToken) ? session("VIEWER") : null,
  );
  fixture.findProducts.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("AUTH_REQUEST_BOUND_SESSION", () => {
  it("合法 Cookie 读取本人的正常会话", async () => {
    fixture.token = adminToken;
    expect(await getSession()).toMatchObject({ id: "admin", role: "ADMIN" });
    expect((await GET(new Request("http://localhost/api/products"))).status).toBe(200);
  });

  it("persistent admin 存在时，无 Cookie 的受保护 API 仍返回 401", async () => {
    const response = await GET(new Request("http://localhost/api/products"));
    expect(response.status).toBe(401);
    expect((await response.json()).errorDetail.code).toBe("UNAUTHENTICATED");
    expect(fixture.findSession).not.toHaveBeenCalled();
    expect(fixture.findProducts).not.toHaveBeenCalled();
  });

  it("persistent admin 存在时，invalid Cookie 不得回退且返回 401", async () => {
    fixture.token = randomBytes(32).toString("base64url");
    expect((await GET(new Request("http://localhost/api/products"))).status).toBe(401);
    expect(fixture.findSession).toHaveBeenCalledTimes(1);
    expect(fixture.findProducts).not.toHaveBeenCalled();
  });

  it.each(["expired", "revoked", "version", "disabled", "accountExpired"])(
    "%s 会话不能访问受保护 API",
    async (kind) => {
      fixture.token = viewerToken;
      const current = session("VIEWER");
      if (kind === "expired") current.expiresAt = new Date(Date.now() - 1);
      if (kind === "revoked") current.revokedAt = new Date();
      if (kind === "version") current.user.sessionVersion += 1;
      if (kind === "disabled") current.user.status = "DISABLED";
      if (kind === "accountExpired") current.user.expiresAt = new Date(Date.now() - 1);
      fixture.findSession.mockResolvedValue(current);
      expect((await GET(new Request("http://localhost/api/products"))).status).toBe(401);
    },
  );

  it("VIEWER Cookie 不会继承 persistent ADMIN 的身份和写权限", async () => {
    fixture.token = viewerToken;
    expect(await getSession()).toMatchObject({ id: "viewer", role: "VIEWER" });
    expect((await POST(new Request("http://localhost/api/products", { method: "POST" }))).status).toBe(403);
  });

  it("退出登录仅撤销当前请求 Cookie，不撤销其他持久登录账号", async () => {
    fixture.token = viewerToken;
    await clearSession();
    expect(fixture.revokeSession).toHaveBeenCalledWith({
      where: { tokenHash: hash(viewerToken), revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    fixture.revokeSession.mockClear();
    fixture.token = undefined;
    await clearSession();
    expect(fixture.revokeSession).not.toHaveBeenCalled();
  });

  it("可信 Desktop bootstrap 只在当前 WebView 安装 HttpOnly 请求 Cookie", async () => {
    const set = vi.fn(async ({ value }) => { fixture.token = value; });
    await expect(restoreDesktopSessionCookie({
      session: { cookies: { get: vi.fn().mockResolvedValue([]), set } },
      origin: "http://127.0.0.1:3100",
      token: viewerToken,
    })).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith({
      url: "http://127.0.0.1:3100",
      name: "veridia_local_session", value: viewerToken,
      path: "/", httpOnly: true, secure: false, sameSite: "lax",
    });
    expect(await getSession()).toMatchObject({ id: "viewer", role: "VIEWER" });
  });

  it("Desktop bootstrap 保留已有 WebView 身份并拒绝远程 origin", async () => {
    const set = vi.fn();
    const jar = { cookies: { get: vi.fn().mockResolvedValue([{ value: viewerToken }]), set } };
    expect(await restoreDesktopSessionCookie({ session: jar, origin: "http://127.0.0.1:3100", token: adminToken })).toBe(false);
    expect(set).not.toHaveBeenCalled();
    await expect(restoreDesktopSessionCookie({ session: jar, origin: "https://example.com", token: adminToken })).rejects.toThrow();
  });

  it("持久凭证 IPC 只接受当前 WebView 的可信顶层页面", () => {
    const frame = { url: "http://127.0.0.1:3100/login" };
    const webContents = { mainFrame: frame };
    const window = { webContents };
    expect(isTrustedSessionSender({ sender: webContents, senderFrame: frame }, window, "http://127.0.0.1:3100")).toBe(true);
    expect(isTrustedSessionSender({ sender: webContents, senderFrame: { url: frame.url } }, window, "http://127.0.0.1:3100")).toBe(false);
    frame.url = "https://example.com";
    expect(isTrustedSessionSender({ sender: webContents, senderFrame: frame }, window, "http://127.0.0.1:3100")).toBe(false);
  });

  it("登录创建的会话令牌只保存哈希并安装正常 HttpOnly Cookie", async () => {
    const current = session().user;
    fixture.findUser.mockResolvedValue(current);
    const created = await createSession({ ...current, expiresAt: null, role: "ADMIN" });
    expect(fixture.createSession.mock.calls[0]?.[0].data.tokenHash).toBe(hash(created.persistentToken));
    expect(fixture.setCookie).toHaveBeenCalledWith("veridia_local_session", created.persistentToken, expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }));
  });
});

describe("源码预览请求级认证", () => {
  function preview() {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERIDIA_LOCAL_PREVIEW", "1");
    vi.stubEnv("VERIDIA_RUNTIME_KIND", "source-preview");
    vi.stubEnv("VERIDIA_DESKTOP", "false");
    vi.stubEnv("VERIDIA_PACKAGED", "false");
  }
  it("显式预览模式无 Cookie 也不能自动成为 ADMIN", async () => {
    preview();
    expect((await GET(new Request("http://localhost/api/products"))).status).toBe(401);
  });
  it("预览 API 仅用一次性凭证建立请求 Cookie，后续无 Cookie 仍为 401", async () => {
    preview();
    const nonce = randomBytes(32).toString("base64url");
    vi.stubEnv("VERIDIA_PREVIEW_BOOTSTRAP_NONCE", nonce);
    vi.stubEnv("VERIDIA_PREVIEW_BOOTSTRAP_EXPIRES_AT", String(Date.now() + 60_000));
    const current = session();
    current.user.id = "veridia-local-preview-user";
    current.user.authProvider = "LOCAL_PREVIEW";
    fixture.ensurePreview.mockResolvedValue({ ...current.user, expiresAt: null });
    fixture.findUser.mockResolvedValue(current.user);
    fixture.findSession.mockResolvedValue(current);
    fixture.setCookie.mockImplementation((_name, token) => { fixture.token = token; });
    const request = () => new Request("http://localhost/api/auth/preview-bootstrap", {
      method: "POST", body: JSON.stringify({ nonce }),
    });
    const response = await PREVIEW_BOOTSTRAP(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { restored: true } });
    expect((await GET(new Request("http://localhost/api/products"))).status).toBe(200);
    expect((await PREVIEW_BOOTSTRAP(request())).status).toBe(401);
    expect(fixture.ensurePreview).toHaveBeenCalledTimes(1);
    fixture.token = undefined;
    expect((await GET(new Request("http://localhost/api/products"))).status).toBe(401);
  });
  it("生产预览 API 即使获得 nonce 也拒绝，不创建账号或会话", async () => {
    preview();
    vi.stubEnv("NODE_ENV", "production");
    const nonce = randomBytes(32).toString("base64url");
    vi.stubEnv("VERIDIA_PREVIEW_BOOTSTRAP_NONCE", nonce);
    vi.stubEnv("VERIDIA_PREVIEW_BOOTSTRAP_EXPIRES_AT", String(Date.now() + 60_000));
    expect((await PREVIEW_BOOTSTRAP(new Request("http://localhost/api/auth/preview-bootstrap", {
      method: "POST", body: JSON.stringify({ nonce }),
    }))).status).toBe(401);
    expect(fixture.ensurePreview).not.toHaveBeenCalled();
    expect(fixture.createSession).not.toHaveBeenCalled();
  });
  it("预览启动 nonce 必须正确、未过期且只消费一次，生产始终拒绝", () => {
    preview();
    const nonce = randomBytes(32).toString("base64url");
    vi.stubEnv("VERIDIA_PREVIEW_BOOTSTRAP_NONCE", nonce);
    vi.stubEnv("VERIDIA_PREVIEW_BOOTSTRAP_EXPIRES_AT", String(Date.now() + 60_000));
    expect(consumePreviewBootstrapNonce("x".repeat(43))).toBe(false);
    expect(consumePreviewBootstrapNonce("你".repeat(43))).toBe(false);
    expect(consumePreviewBootstrapNonce(nonce)).toBe(true);
    expect(consumePreviewBootstrapNonce(nonce)).toBe(false);
    vi.stubEnv("VERIDIA_PREVIEW_BOOTSTRAP_NONCE", randomBytes(32).toString("base64url"));
    vi.stubEnv("VERIDIA_PREVIEW_BOOTSTRAP_EXPIRES_AT", String(Date.now() - 1));
    expect(consumePreviewBootstrapNonce(process.env.VERIDIA_PREVIEW_BOOTSTRAP_NONCE)).toBe(false);
    vi.stubEnv("VERIDIA_PREVIEW_BOOTSTRAP_EXPIRES_AT", String(Date.now() + 60_000));
    vi.stubEnv("NODE_ENV", "production");
    expect(consumePreviewBootstrapNonce(process.env.VERIDIA_PREVIEW_BOOTSTRAP_NONCE)).toBe(false);
  });
});
