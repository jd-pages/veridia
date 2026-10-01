"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Self-owned CommonJS process fixture exercises the pinned CommonJS reporter without converting its module contract. */
// Fresh-child fixture: actual pinned Next module bytes, native independent
// WriteStreams, and a module-local fs facade. No global fs monkeypatch or
// installed dependency/real trace write is performed by this child.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");
const { errorMonitor } = require("node:events");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const variant = process.argv[2];
const scenario = process.argv[3];
const scratch = path.resolve(process.argv[4] || "");
const expectedRoot = path.join(root, ".playwright", "next-trace-single-flight-tests");
if (!["original", "patched", "queue-only"].includes(variant) || path.dirname(scratch) !== expectedRoot ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(path.basename(scratch))) throw new Error("Owned GUID scratch required");
const counts = { "natural-202": 202, "natural-303": 303, "natural-44batch": 44 * 101, "baseline-100": 100,
  "filter": 202, "dev-append": 303, "rotation": 303, "instances": 303, "mkdir-error": 202, "open-error": 202,
  "early-flush-drain": 4040, "tail-flush-drain": 111 };
if (!(scenario in counts)) throw new Error("Unknown fixture scenario");
fs.mkdirSync(scratch, { recursive: true });
const dist = path.join(scratch, "dist");
const evidencePath = path.join(scratch, "evidence.json");
const states = [];
let mkdirCount = 0;
let rejectedFlushes = 0;
let wrongError = false;
let releaseMkdir;
let publishDuringTailWrite;
const mkdirGate = ["early-flush-drain", "tail-flush-drain"].includes(scenario) ? new Promise((resolve) => { releaseMkdir = resolve; }) : null;
const injectedError = Object.assign(new Error("SYNTHETIC_EXPECTED_TRACE_ERROR"), { code: scenario === "mkdir-error" ? "EACCES" : "EBUSY", syscall: scenario === "mkdir-error" ? "mkdir" : "open" });
const save = (data) => fs.writeFileSync(evidencePath, JSON.stringify({ synthetic: true, variant, scenario,
  dependencyWritten: false, globalFsMonkeypatch: false, ...data }) + "\n", { flag: "wx" });
process.on("uncaughtExceptionMonitor", (error, origin) => save({ fatalErrorIsOriginal: error === injectedError,
  code: error.code, syscall: error.syscall, origin, mkdirCount, rejectedFlushes, writerCount: states.length,
  passed: error === injectedError && !wrongError && mkdirCount === 1 && (scenario !== "mkdir-error" || rejectedFlushes === 2) }));
const facade = {
  ...fs,
  promises: { ...fs.promises, mkdir: async (...args) => {
    mkdirCount++;
    if (scenario === "mkdir-error") throw injectedError;
    if (mkdirGate) await mkdirGate; // Condition gate only; native mkdir/stream remain unchanged.
    return fs.promises.mkdir(...args);
  } },
  createWriteStream: (filename, options) => {
    let nativeOptions = options;
    if (scenario === "open-error") nativeOptions = { ...options, fs: {
      open: (_file, _flags, _mode, callback) => setImmediate(() => callback(injectedError)),
      write: fs.write, writev: fs.writev, close: fs.close,
    } };
    const stream = fs.createWriteStream(filename, nativeOptions);
    const state = { stream, filename, flags: options.flags, fd: null, endCalls: 0 };
    states.push(state);
    stream.on("open", (fd) => { state.fd = fd; });
    stream.on(errorMonitor, () => {}); // observation never consumes native error
    const end = stream.end;
    stream.end = function (...args) { state.endCalls++; return Reflect.apply(end, this, args); };
    if (scenario === "tail-flush-drain") {
      const write = stream.write;
      stream.write = function (...args) {
        const accepted = Reflect.apply(write, this, args);
        // Publish only after the actual first tail serialization/native write.
        // Forward the native return value; do not change HWM, callbacks or errors.
        if (publishDuringTailWrite) { const publish = publishDuringTailWrite; publishDuringTailWrite = null; publish(); }
        return accepted;
      };
    }
    return stream;
  },
};
const snapshot = () => states.map(({ stream, filename, flags, fd, endCalls }) => ({ filename: path.basename(filename), flags,
  fd, endCalls, closed: stream.closed, ended: stream.writableEnded, finished: stream.writableFinished }));
const waitClosed = (stream) => stream.closed ? Promise.resolve() : new Promise((resolve) => stream.once("close", resolve));
(async () => {
  const { transformNextTraceSingleFlight, NEXT_TRACE_SINGLE_FLIGHT_PATCH } = await import(pathToFileURL(path.join(root, "scripts/testing/next-trace-single-flight.mjs")));
  const fixtureSource = fs.readFileSync(path.join(__dirname, "next-trace-original.cjs"));
  let actualSource = variant === "original" ? fixtureSource : transformNextTraceSingleFlight({ version: "16.3.4", source: fixtureSource }).source;
  if (variant === "queue-only") {
    const drainedBlock = "            while(queue.size > 0 || events.length > 0){\n                await Promise.all(queue);\n                if (events.length > 0) {\n                    const evts = events.slice();\n                    events.length = 0;\n                    await reportEvents(evts);\n                }\n            }";
    actualSource = Buffer.from(actualSource.toString("utf8").replace(drainedBlock,
      "            while(queue.size > 0){\n                await Promise.all(queue);\n            }\n            if (events.length > 0) {\n                await reportEvents(events);\n                events.length = 0;\n            }"));
    if (createHash("sha256").update(actualSource).digest("hex") !== NEXT_TRACE_SINGLE_FLIGHT_PATCH.queueSnapshotDrainOnlySha256) throw new Error("Pinned earlier reporter required");
  }
  const installed = path.join(root, "node_modules/next/dist/trace/report/to-json.js");
  const globals = require(path.join(root, "node_modules/next/dist/trace/shared.js"));
  const constants = require(path.join(root, "node_modules/next/dist/shared/lib/constants.js"));
  globals.setGlobal("distDir", dist);
  const dev = scenario === "dev-append" || scenario === "rotation";
  globals.setGlobal("phase", dev ? constants.PHASE_DEVELOPMENT_SERVER : constants.PHASE_PRODUCTION_BUILD);
  const copiedModule = new Module(installed, module);
  copiedModule.filename = installed;
  copiedModule.paths = Module._nodeModulePaths(path.dirname(installed));
  const originalRequire = copiedModule.require;
  copiedModule.require = function (id) { return id === "fs" ? facade : Reflect.apply(originalRequire, this, arguments); };
  copiedModule._compile(actualSource.toString("utf8"), installed);
  const create = (filename = "trace") => copiedModule.exports.createJsonReporter({ filename, sizeLimit: scenario === "rotation" ? 15000 : Infinity,
    ...(scenario === "filter" ? { filter: (event) => event.id % 2 === 0 } : {}) });
  const reporter = create();
  const publish = (owner, offset, count) => { for (let id = offset; id < offset + count; id++) owner.report({
    name: scenario === "tail-flush-drain" ? "synthetic" + "x".repeat(20000) : "synthetic", id }); };
  if (scenario === "mkdir-error") {
    for (let attempt = 0; attempt < 2; attempt++) {
      publish(reporter, attempt * 202, 202);
      try { await reporter.flushAll(); } catch (error) { rejectedFlushes++; if (error !== injectedError) wrongError = true; }
    }
    return; // Existing batcher rejection remains fatal; monitor only observes.
  }
  if (scenario === "open-error") { publish(reporter, 0, 202); await reporter.flushAll(); return; }
  let devFirstFlush = null;
  if (["early-flush-drain", "tail-flush-drain"].includes(scenario)) {
    const firstBatchCount = scenario === "tail-flush-drain" ? 10 : 101;
    publish(reporter, 0, firstBatchCount);
    if (scenario === "tail-flush-drain") publishDuringTailWrite = () => publish(reporter, firstBatchCount, counts[scenario] - firstBatchCount);
    const earlyFlush = reporter.flushAll();
    if (scenario !== "tail-flush-drain") publish(reporter, firstBatchCount, counts[scenario] - firstBatchCount);
    releaseMkdir();
    await earlyFlush;
    await reporter.flushAll();
  } else if (scenario === "rotation") {
    for (let batch = 0; batch < 3; batch++) {
      publish(reporter, batch * 101, 101);
      await reporter.flushAll(batch === 2 ? { end: true } : undefined);
    }
  } else if (scenario === "instances") {
    const other = create("other-trace");
    publish(reporter, 0, 303); publish(other, 1000, 303);
    await Promise.all([reporter.flushAll(), other.flushAll()]);
  } else {
    publish(reporter, 0, counts[scenario]);
    await reporter.flushAll();
    if (dev) {
      devFirstFlush = snapshot();
      publish(reporter, counts[scenario], 17);
      await reporter.flushAll({ end: true });
    }
  }
  for (const { stream } of states) if (stream.writableEnded) await waitClosed(stream);
  const atFlush = snapshot();
  const flushOpenCount = atFlush.filter((state) => !state.closed).length;
  // Close only fixture-owned original race orphans after preserving flush state.
  for (const { stream } of states) {
    if (!stream.writableEnded) await new Promise((resolve) => stream.end(resolve));
    await waitClosed(stream);
  }
  const files = scenario === "instances" ? ["trace", "other-trace"] : ["trace"];
  const outputs = files.map((filename) => {
    let parsed = [];
    let parseError = null;
    try { parsed = fs.readFileSync(path.join(dist, filename), "utf8").trim().split("\n").flatMap((line) => JSON.parse(line)); }
    catch (error) { parseError = error.message; }
    return { filename, count: parsed.length, uniqueIds: new Set(parsed.map((event) => event.id)).size,
      ids: parsed.map((event) => event.id), parseError };
  });
  save({ writerCount: states.length, mkdirCount, atFlush, flushOpenCount, devFirstFlush, outputs });
})().catch((error) => { process.stderr.write(error.stack + "\n"); process.exitCode = 2; });
