"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Run the installed CommonJS CLI unchanged. */

// The CLI cannot run until its creator has retained a native birth-validated
// process handle. This also measures short (< one CIM sample) typegen runs.
const path = require("node:path");
if (typeof process.send !== "function") throw new Error("TYPEGEN_BOOTSTRAP_REQUIRES_IPC");
const entry = path.resolve(process.argv[2]);
const args = JSON.parse(process.argv[3]);
if (!Array.isArray(args) || args.some(value => typeof value !== "string")) {
  throw new Error("TYPEGEN_BOOTSTRAP_ARGUMENTS_INVALID");
}
let released = false;
process.on("disconnect", () => { if (!released) process.exit(1); });
process.once("message", message => {
  if (message?.kind !== "RUN" || message.pid !== process.pid) {
    throw new Error("TYPEGEN_BOOTSTRAP_RELEASE_INVALID");
  }
  released = true;
  process.argv = [process.execPath, entry, ...args];
  process.disconnect();
  // Next's installed CLI is CommonJS and parses process.argv. Do not call its
  // private typegen function or replace its exit/error handling.
  require(entry);
});
process.send({ kind: "READY", pid: process.pid, parentPid: process.ppid });
