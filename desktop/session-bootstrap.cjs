const SESSION_COOKIE_NAME = "veridia_local_session";

function appOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("本地登录恢复地址无效。");
  }
  return url.origin;
}

// Runs only in Electron's trusted main process, before the first app request.
// The saved credential is installed in this WebView's cookie jar; the server
// still validates its expiry, revocation and account on every request.
async function restoreDesktopSessionCookie({ session, origin, token }) {
  const trustedOrigin = appOrigin(origin);
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(token || "")) return false;
  // A WebView that already has a session keeps its own identity. In particular,
  // an older saved ADMIN credential must not replace a newer VIEWER cookie.
  const existing = await session.cookies.get({
    url: trustedOrigin,
    name: SESSION_COOKIE_NAME,
  });
  if (existing.length) return false;
  await session.cookies.set({
    url: trustedOrigin,
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
  });
  return true;
}

function isTrustedSessionSender(event, window, origin) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  ) return false;
  try {
    return new URL(event.senderFrame.url).origin === appOrigin(origin);
  } catch {
    return false;
  }
}

module.exports = { restoreDesktopSessionCookie, isTrustedSessionSender };
