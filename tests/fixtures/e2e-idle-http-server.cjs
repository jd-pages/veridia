/* global require, process */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Standalone Node child fixture is intentionally CommonJS.
const http = require("node:http");
let connectionId = 0;
let postCount = 0;
const events = [];
const server = http.createServer((req, res) => {
  const id = req.socket.fixtureConnectionId;
  const authenticated = req.headers.cookie === "fixture_session=authenticated";
  if (req.method === "POST") postCount += 1;
  req.resume();
  events.push({ method: req.method, path: req.url, connectionId: id, authenticated });
  res.setHeader("content-type", "application/json");
  if (req.url === "/session") res.setHeader("set-cookie", "fixture_session=authenticated; Path=/; HttpOnly");
  if (req.url === "/http-error") res.statusCode = 409;
  res.end(JSON.stringify({ pid: process.pid, connectionId: id, authenticated, postCount,
    idleDeadline: Date.now() + server.keepAliveTimeout + server.keepAliveTimeoutBuffer }));
});
// A positive advertised 2-second timeout is necessary for Node's native
// pooled agent to retain this socket. The extra 10ms is the real server buffer,
// not a fake reset or an artificially shortened client request timeout.
server.keepAliveTimeout = 2_000;
server.keepAliveTimeoutBuffer = 10;
server.on("connection", socket => {
  socket.fixtureConnectionId = ++connectionId;
  socket.on("timeout", () => events.push({ event: "idle-timeout", connectionId: socket.fixtureConnectionId }));
});
process.on("message", message => {
  if (message === "snapshot") process.send({ event: "snapshot", pid: process.pid, postCount, events });
  if (message === "stop") { server.closeAllConnections(); server.close(() => process.exit(0)); }
});
server.listen(0, "127.0.0.1", () => process.send({ event: "ready", pid: process.pid, port: server.address().port }));
