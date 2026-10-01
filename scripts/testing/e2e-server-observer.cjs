/* eslint-disable @typescript-eslint/no-require-imports -- Node --require preload must remain synchronous CommonJS. */
/* global require, process, setInterval, module */
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

function redactE2eDiagnosticText(value, secrets = []) {
  let text = String(value || "")
    .replace(/\u001b\[[0-9;]*m/gu, "")
    .replace(/^(\s*(?:[-] )?(?:cookie|set-cookie|authorization|proxy-authorization)\s*:).*$/gimu, "$1 [REDACTED]")
    .replace(/((?:token|password|secret|api[_-]?key|veridia_local_session)["']?\s*[:=]\s*["']?)([^\s,;"'}]+)/giu, "$1[REDACTED]")
    .replace(/([?&](?:token|signature|key|auth)=)[^&\s]+/giu, "$1[REDACTED]");
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[REDACTED]");
  return text;
}

function installServerObserver(directory, port) {
  try { fs.mkdirSync(directory, { recursive: true }); }
  catch { return; }
  const file = path.join(directory, `server-process-${process.pid}.json`);
  const startedAt = new Date().toISOString();
  const events = [];
  const pendingRequests = new Map();
  let sequence = 0;
  let nextConnectionId = 0;
  let activeConnections = 0;
  let state = "STARTING";
  let lastRequest = null;
  let listening = false;
  let exitCode = null;
  const secrets = [process.env.AUTH_SECRET, process.env.EXTENSION_TOKEN, process.env.OPENAI_API_KEY];
  const remember = event => {
    events.push({ at: new Date().toISOString(), ...event });
    if (events.length > 100) events.shift();
  };
  const snapshot = () => ({
    schemaVersion: 1, pid: process.pid, parentPid: process.ppid, startedAt,
    capturedAt: new Date().toISOString(), state, port, listening, exitCode,
    memory: process.memoryUsage(), activeResources: process.getActiveResourcesInfo(),
    activeConnections, lastRequest, pendingRequests: [...pendingRequests.values()], events,
  });
  const persist = () => {
    try {
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(snapshot(), null, 2)}\n`);
      fs.renameSync(temporary, file);
    } catch { /* Diagnostics must not change application behavior. */ }
  };
  const originalCreateServer = http.createServer;
  http.createServer = function (...args) {
    const server = originalCreateServer.apply(this, args);
    const ownsPort = () => server.address()?.port === port;
    server.on("listening", () => {
      if (!ownsPort()) return;
      state = "LISTENING";
      listening = true;
      remember({ event: "listening", keepAliveTimeout: server.keepAliveTimeout, keepAliveTimeoutBuffer: server.keepAliveTimeoutBuffer });
      persist();
    });
    server.on("close", () => {
      if (!listening) return;
      state = "CLOSED";
      listening = false;
      remember({ event: "server-close" });
      persist();
    });
    server.on("connection", socket => {
      if (!ownsPort()) return;
      const connectionId = ++nextConnectionId;
      socket.veridiaE2eConnectionId = connectionId;
      activeConnections += 1;
      socket.on("timeout", () => remember({ event: "socket-timeout", connectionId }));
      socket.on("close", hadError => {
        activeConnections -= 1;
        remember({ event: "socket-close", connectionId, hadError });
      });
    });
    server.prependListener("request", (req, res) => {
      if (!ownsPort()) return;
      const pathname = String(req.url || "").split("?")[0];
      if (!pathname.startsWith("/api/")) return;
      const id = ++sequence;
      const request = { id, method: req.method, pathname, connectionId: req.socket.veridiaE2eConnectionId, startedAt: new Date().toISOString() };
      lastRequest = request;
      pendingRequests.set(id, request);
      const complete = event => {
        if (!pendingRequests.delete(id)) return;
        remember({ event, ...request, status: res.statusCode, writableFinished: res.writableFinished });
      };
      res.once("finish", () => complete("request-finish"));
      res.once("close", () => complete("request-close"));
    });
    return server;
  };
  // Observe exception events without adding a listener that would suppress
  // Node's existing unhandled-rejection/uncaught-exception exit semantics.
  const originalEmit = process.emit;
  process.emit = function (event, ...args) {
    if (event === "uncaughtException" || event === "unhandledRejection") {
      const error = args[0];
      remember({ event, error: { name: error?.name, code: error?.code, message: redactE2eDiagnosticText(error?.message || error, secrets).slice(0, 1000) } });
      persist();
    }
    return originalEmit.call(this, event, ...args);
  };
  process.once("exit", code => {
    exitCode = code;
    state = "EXITED";
    remember({ event: "process-exit", code });
    persist();
  });
  const timer = setInterval(persist, 2000);
  timer.unref();
  persist();
}

module.exports = { redactE2eDiagnosticText, installServerObserver };
if (process.env.VERIDIA_E2E === "true" && process.env.VERIDIA_E2E_SERVER_DIAGNOSTIC_DIR) {
  installServerObserver(process.env.VERIDIA_E2E_SERVER_DIAGNOSTIC_DIR, Number(process.env.E2E_PORT));
}
