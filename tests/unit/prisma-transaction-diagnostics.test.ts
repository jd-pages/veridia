import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  installE2ePrismaTransactionDiagnostics,
  readE2ePrismaTransactionDiagnostics,
} from "@/lib/testing/prisma-transaction-diagnostics";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("E2E-only explicit singleton Prisma transaction lifetimes", () => {
  it("installs on the native Prisma proxy without connecting or executing any query", () => {
    const host = {};
    const probe = path.resolve(".playwright/stability141/never-open-transaction-diagnostics-probe.db");
    const existed = fs.existsSync(probe);
    const client = new PrismaClient({ datasourceUrl: `file:${probe.replaceAll("\\", "/")}`, log: [] });
    installE2ePrismaTransactionDiagnostics(client, true, host);
    expect(readE2ePrismaTransactionDiagnostics(client, true, host)).toMatchObject({
      measurement: "AVAILABLE", singletonRegistered: true, wrapperIntact: true,
      pendingTransactionCount: 0, observedTransactionCount: 0,
    });
    // No $connect, query, transaction, or filesystem mutation occurs here.
    expect(fs.existsSync(probe)).toBe(existed);
  });
  it("does not install production tracking or invent a zero when disabled/unregistered", async () => {
    const host = {};
    const original = vi.fn().mockResolvedValue("untouched");
    const client = { $transaction: original };
    installE2ePrismaTransactionDiagnostics(client, false, host);
    expect(client.$transaction).toBe(original);
    expect(readE2ePrismaTransactionDiagnostics(client, false, host)).toMatchObject({ measurement: "NOT_RUN", pendingTransactionCount: null });
    expect(readE2ePrismaTransactionDiagnostics(client, true, host)).toMatchObject({ measurement: "NOT_RUN", pendingTransactionCount: null });
    await expect(client.$transaction([])).resolves.toBe("untouched");
  });

  it("forwards batch arguments/options/receiver once without evaluating lazy child promises", async () => {
    const host = {};
    const completion = deferred<object>();
    const receivers: object[] = [];
    let forwarded: unknown[] = [];
    const original = vi.fn(function (this: object, ...args: unknown[]) {
      receivers.push(this); forwarded = args; return completion.promise;
    });
    const client = { $transaction: original };
    const lazy = { then: vi.fn() };
    const queries = [lazy];
    const options = { isolationLevel: "Serializable" };
    installE2ePrismaTransactionDiagnostics(client, true, host);
    const observed = client.$transaction(queries, options);
    // Promise identity/microtask timing changes are explicit; public values,
    // errors, overload arguments and lazy batch query identities do not change.
    expect(observed).not.toBe(completion.promise);
    expect(receivers).toEqual([client]);
    expect(forwarded[0]).toBe(queries);
    expect(forwarded[1]).toBe(options);
    expect(lazy.then).not.toHaveBeenCalled();
    expect(original).toHaveBeenCalledTimes(1);
    expect(readE2ePrismaTransactionDiagnostics(client, true, host)).toMatchObject({ measurement: "AVAILABLE", pendingTransactionCount: 1, observedBatchTransactionCount: 1 });
    const value = {};
    completion.resolve(value);
    await expect(observed).resolves.toBe(value);
    expect(readE2ePrismaTransactionDiagnostics(client, true, host)).toMatchObject({ pendingTransactionCount: 0, observedTransactionCount: 1, settledTransactionCount: 1 });
  });

  it("tracks the interactive outer promise through commit, not merely callback completion", async () => {
    const host = {};
    const commit = deferred<void>();
    const callbackFinished = deferred<void>();
    const value = {};
    const options = { timeout: 100, maxWait: 50 };
    const tx = {};
    const callback = vi.fn(async (received: object) => { expect(received).toBe(tx); callbackFinished.resolve(); return value; });
    const original = vi.fn(async function (this: object, received: typeof callback, receivedOptions: typeof options) {
      expect(received).toBe(callback); expect(receivedOptions).toBe(options);
      const result = await received(tx);
      await commit.promise;
      return result;
    });
    const client = { $transaction: original };
    installE2ePrismaTransactionDiagnostics(client, true, host);
    const observed = client.$transaction(callback, options);
    await callbackFinished.promise;
    expect(readE2ePrismaTransactionDiagnostics(client, true, host)).toMatchObject({ pendingTransactionCount: 1, observedInteractiveTransactionCount: 1 });
    commit.resolve();
    await expect(observed).resolves.toBe(value);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(original).toHaveBeenCalledTimes(1);
    expect(readE2ePrismaTransactionDiagnostics(client, true, host).pendingTransactionCount).toBe(0);
  });

  it("settles parallel transactions independently and preserves asynchronous rejection identity", async () => {
    const host = {};
    const pending = [deferred<string>(), deferred<string>(), deferred<string>()];
    let invocation = 0;
    const client = { $transaction: vi.fn(() => pending[invocation++].promise) };
    installE2ePrismaTransactionDiagnostics(client, true, host);
    const observations = pending.map(() => client.$transaction());
    expect(readE2ePrismaTransactionDiagnostics(client, true, host).pendingTransactionCount).toBe(3);
    pending[1].resolve("second");
    await expect(observations[1]).resolves.toBe("second");
    expect(readE2ePrismaTransactionDiagnostics(client, true, host).pendingTransactionCount).toBe(2);
    const reason = new Error("same rejection identity");
    const rejected = observations[0].catch(error => error);
    pending[0].reject(reason);
    expect(await rejected).toBe(reason);
    pending[2].resolve("third");
    await observations[2];
    expect(readE2ePrismaTransactionDiagnostics(client, true, host)).toMatchObject({ pendingTransactionCount: 0, observedTransactionCount: 3, settledTransactionCount: 3 });
  });

  it("preserves synchronous throw and primitive rejection reasons without leaking a pending entry", async () => {
    const host = {};
    const reason = new Error("synchronous");
    const client = { $transaction: vi.fn((): Promise<never> => { throw reason; }) };
    installE2ePrismaTransactionDiagnostics(client, true, host);
    expect(() => client.$transaction()).toThrow(reason);
    expect(readE2ePrismaTransactionDiagnostics(client, true, host)).toMatchObject({ pendingTransactionCount: 0, settledTransactionCount: 1 });
    const rejectedClient = { $transaction: () => Promise.reject("primitive original") };
    const otherHost = {};
    installE2ePrismaTransactionDiagnostics(rejectedClient, true, otherHost);
    expect(await rejectedClient.$transaction().catch(error => error)).toBe("primitive original");
    expect(readE2ePrismaTransactionDiagnostics(rejectedClient, true, otherHost).pendingTransactionCount).toBe(0);
  });

  it("hot reload does not duplicate wrapping and changed/unknown clients fail coverage closed", async () => {
    const host = {};
    const original = vi.fn().mockResolvedValue(7);
    const client = { $transaction: original };
    installE2ePrismaTransactionDiagnostics(client, true, host);
    const wrapper = client.$transaction;
    installE2ePrismaTransactionDiagnostics(client, true, host);
    expect(client.$transaction).toBe(wrapper);
    await client.$transaction();
    expect(readE2ePrismaTransactionDiagnostics(client, true, host).observedTransactionCount).toBe(1);
    expect(original).toHaveBeenCalledTimes(1);
    client.$transaction = original;
    expect(readE2ePrismaTransactionDiagnostics(client, true, host)).toMatchObject({ measurement: "INVALID", wrapperIntact: false, pendingTransactionCount: null });
    const unknown = { $transaction: original };
    installE2ePrismaTransactionDiagnostics(unknown, true, host);
    expect(unknown.$transaction).toBe(original);
    expect(readE2ePrismaTransactionDiagnostics(unknown, true, host)).toMatchObject({ measurement: "INVALID", singletonRegistered: false, pendingTransactionCount: null });
  });

  it("an immutable method leaves application behavior intact but cannot be counted as installed", async () => {
    const host = {};
    const original = vi.fn().mockResolvedValue(9);
    const client = Object.freeze({ $transaction: original });
    installE2ePrismaTransactionDiagnostics(client, true, host);
    expect(client.$transaction).toBe(original);
    await expect(client.$transaction()).resolves.toBe(9);
    expect(readE2ePrismaTransactionDiagnostics(client, true, host)).toMatchObject({ measurement: "INVALID", pendingTransactionCount: null });
  });

  it("borrowing the method preserves the receiver but refuses singleton coverage", async () => {
    const host = {};
    const receivers: object[] = [];
    const client = { $transaction: function (this: object) { receivers.push(this); return Promise.resolve(3); } };
    installE2ePrismaTransactionDiagnostics(client, true, host);
    const other = {};
    await expect(client.$transaction.call(other)).resolves.toBe(3);
    expect(receivers).toEqual([other]);
    expect(readE2ePrismaTransactionDiagnostics(client, true, host)).toMatchObject({ measurement: "INVALID", pendingTransactionCount: null });
  });

  it("an actually ignored rejected transaction stays fatal in a separate Node process", () => {
    const source = fs.readFileSync(path.resolve("lib/testing/prisma-transaction-diagnostics.ts"), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const child = spawnSync(process.execPath, ["-e", `${compiled}\nconst client = { $transaction() { return Promise.reject(new Error('E2E_TRANSACTION_FATAL_MARKER')); } }; exports.installE2ePrismaTransactionDiagnostics(client, true, {}); client.$transaction([]);`], { encoding: "utf8", windowsHide: true, timeout: 3_000 });
    expect(child.status).not.toBe(0);
    expect(child.error).toBeUndefined();
    expect(child.stderr).toContain("E2E_TRANSACTION_FATAL_MARKER");
  });
});

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.tsx?$/u.test(file) ? [file] : [];
  });
}

describe("finite application transaction observation coverage", () => {
  it("all audited app/lib constructors, extensions and transaction receivers remain within the explicit singleton boundary", () => {
    const constructors: string[] = [];
    const extensions: string[] = [];
    const receivers = new Set<string>();
    const dependencies = new Map<string, string[]>();
    const all = [...sourceFiles("app"), ...sourceFiles("lib")];
    for (const file of all) {
      const source = fs.readFileSync(file, "utf8");
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const relative = file.replaceAll("\\", "/");
      const imports: string[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isNewExpression(node) && node.expression.getText(parsed) === "PrismaClient") constructors.push(relative);
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          if (node.expression.name.text === "$extends") extensions.push(relative);
          if (node.expression.name.text === "$transaction") receivers.add(node.expression.expression.getText(parsed));
        }
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
        ts.forEachChild(node, visit);
      };
      visit(parsed);
      dependencies.set(path.resolve(file), imports.flatMap(specifier => {
        if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return [];
        const target = specifier.startsWith("@/") ? path.resolve(specifier.slice(2)) : path.resolve(path.dirname(file), specifier);
        return [target, `${target}.ts`, `${target}.tsx`, path.join(target, "index.ts"), path.join(target, "index.tsx")].filter(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      }));
    }
    expect(constructors.sort()).toEqual(["lib/db.ts", "lib/rules/database-preflight.ts", "lib/rules/publish-source.ts"]);
    expect(extensions).toEqual([]);
    expect([...receivers].sort()).toEqual(["database", "prisma"]);
    const reachable = new Set<string>();
    const pending = sourceFiles("app").map(file => path.resolve(file));
    while (pending.length) {
      const file = pending.pop()!;
      if (reachable.has(file)) continue;
      reachable.add(file); pending.push(...(dependencies.get(file) || []));
    }
    for (const cliOnly of ["lib/rules/database-preflight.ts", "lib/rules/publish-source.ts"]) {
      expect(reachable.has(path.resolve(cliOnly))).toBe(false);
      expect(fs.readFileSync(cliOnly, "utf8")).toMatch(/finally\s*\{\s*await client\.\$disconnect\(\)/u);
    }
    const db = fs.readFileSync("lib/db.ts", "utf8");
    expect(db).toContain('installE2ePrismaTransactionDiagnostics(prisma, process.env.VERIDIA_E2E === "true")');
    expect(db.indexOf("globalForPrisma.prisma ??")).toBeLessThan(db.indexOf("installE2ePrismaTransactionDiagnostics(prisma,"));
  });

  it("cached recovery is awaited by the registered runner; cached presence itself is never labeled pending", () => {
    const queue = fs.readFileSync("lib/automation/queue.ts", "utf8").replaceAll("\r\n", "\n");
    const parsed = ts.createSourceFile("queue.ts", queue, ts.ScriptTarget.Latest, true);
    const body = (name: string) => {
      const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
      if (!declaration || !ts.isFunctionDeclaration(declaration) || !declaration.body) throw new Error(`Missing ${name}`);
      return declaration.body.getText(parsed);
    };
    expect(body("ensureRecovered")).toContain("queueState.recovery ??= recoverInterruptedQueue()");
    expect(body("ensureRecovered")).toContain("await queueState.recovery");
    expect(body("runQueue")).toContain("await ensureRecovered()");
    expect(body("recoverInterruptedQueue")).toContain("await recoverInterruptedAutomaticBatches()");
    const runner = body("startAutomaticAuditQueueRunner");
    expect(runner.indexOf("const runner = runQueue()")).toBeLessThan(runner.indexOf(".finally("));
    expect(runner.indexOf(".finally(")).toBeLessThan(runner.indexOf("queueState.runner = undefined"));
    expect(runner).toContain("queueState.runner = runner");
    const calls: string[] = [];
    const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "ensureRecovered") calls.push(node.parent.getText(parsed)); ts.forEachChild(node, visit); };
    visit(parsed);
    expect(calls).toEqual(["await ensureRecovered()"]);
  });
});
