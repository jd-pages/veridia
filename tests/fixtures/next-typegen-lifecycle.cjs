"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Fixture for the actual CommonJS CLI launcher. */
// Self-owned launcher fixture only. Never import Next/Prisma or access a DB.
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const mode = process.argv[2];
if (mode === "instant" || mode === "failure") {
  fs.writeFileSync(process.argv[3], JSON.stringify({ pid: process.pid, parentPid: process.ppid,
    ranAt: new Date().toISOString(), argv: process.argv.slice(2),
    overridesPresent: ["VERIDIA_NEXT_DIST_DIR", "VERIDIA_NEXT_TSCONFIG_PATH", "E2E_NEXT_DIST_DIR"]
      .filter(name => Object.hasOwn(process.env, name)) }), { flag: "wx" });
  process.exit(mode === "failure" ? 7 : 0);
} else if (mode === "stall") {
  setInterval(() => {}, 1000);
} else if (mode === "child-hold") {
  const deadline = Date.now() + 15000;
  const interval = setInterval(() => {
    if (fs.existsSync(process.argv[3]) || Date.now() > deadline) { clearInterval(interval); process.exit(0); }
  }, 50);
} else if (mode === "parent-with-child" || mode === "orphan-root") {
  const child = spawn(process.execPath, [__filename, "child-hold", process.argv[4]],
    { windowsHide: true, detached: true, stdio: "ignore" });
  fs.writeFileSync(process.argv[3], JSON.stringify({ pid: process.pid, childPid: child.pid }), { flag: "wx" });
  if (mode === "parent-with-child") child.once("exit", code => process.exit(code ?? 1));
  else {
    child.unref();
    const deadline = Date.now() + 12000;
    const interval = setInterval(() => {
      if (fs.existsSync(process.argv[5]) || Date.now() > deadline) { clearInterval(interval); process.exit(0); }
    }, 50);
  }
} else {
  throw new Error("OWNED_TYPEGEN_FIXTURE_MODE_INVALID");
}
