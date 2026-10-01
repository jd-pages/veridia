// Test-only observation of public explicit transaction promises. This does not
// observe implicit CRUD transactions or the native engine's connection state.
export const E2E_PRISMA_TRANSACTION_SCOPE = "APP_LIB_SINGLETON_EXPLICIT_TRANSACTIONS";

type TransactionMethod = (this: object, ...args: unknown[]) => Promise<unknown>;
type TransactionClient = { $transaction: TransactionMethod };
type Registry = {
  client: object;
  wrapper: TransactionMethod;
  pending: Set<number>;
  observed: number;
  settled: number;
  batch: number;
  interactive: number;
  other: number;
  invalid: boolean;
};
const registryKey = Symbol.for("veridia.e2e.prisma-explicit-transactions");
type RegistryHost = { [registryKey]?: Registry };

export interface E2ePrismaTransactionDiagnostics {
  measurement: "AVAILABLE" | "NOT_RUN" | "INVALID";
  coverageScope: typeof E2E_PRISMA_TRANSACTION_SCOPE;
  singletonRegistered: boolean;
  wrapperIntact: boolean;
  pendingTransactionCount: number | null;
  observedTransactionCount: number;
  settledTransactionCount: number;
  observedBatchTransactionCount: number;
  observedInteractiveTransactionCount: number;
  observedOtherTransactionCount: number;
}

export function installE2ePrismaTransactionDiagnostics(
  client: object,
  enabled: boolean,
  host: RegistryHost = globalThis as RegistryHost,
) {
  if (!enabled) return;
  const existing = host[registryKey];
  if (existing) {
    try {
      if (existing.client !== client || (client as TransactionClient).$transaction !== existing.wrapper) existing.invalid = true;
    } catch { existing.invalid = true; }
    return;
  }
  let original: TransactionMethod;
  try { original = (client as TransactionClient).$transaction; }
  catch { return; }
  if (typeof original !== "function") return;
  const registry: Registry = { client, wrapper: original, pending: new Set(),
    observed: 0, settled: 0, batch: 0, interactive: 0, other: 0, invalid: false };
  const settle = (id: number) => {
    if (registry.pending.delete(id)) registry.settled += 1;
  };
  // Keep a plain function: synchronous throws and the original receiver/argument
  // identities must remain visible to the caller. The returned chain rethrows
  // the same rejection; no fire-and-forget observer can swallow a fatal error.
  const wrapper: TransactionMethod = function (...args) {
    if (this !== client) registry.invalid = true;
    const id = ++registry.observed;
    registry.pending.add(id);
    if (Array.isArray(args[0])) registry.batch += 1;
    else if (typeof args[0] === "function") registry.interactive += 1;
    else registry.other += 1;
    try {
      const promise = Reflect.apply(original, this, args) as Promise<unknown>;
      return promise.then(
        value => { settle(id); return value; },
        error => { settle(id); throw error; },
      );
    } catch (error) {
      settle(id);
      throw error;
    }
  };
  registry.wrapper = wrapper;
  host[registryKey] = registry;
  try {
    if (!Reflect.set(client, "$transaction", wrapper) || (client as TransactionClient).$transaction !== wrapper) registry.invalid = true;
  } catch {
    // Missing diagnostics must fail the E2E evidence gate, not application work.
    registry.invalid = true;
  }
}

export function readE2ePrismaTransactionDiagnostics(
  client: object,
  enabled: boolean,
  host: RegistryHost = globalThis as RegistryHost,
): E2ePrismaTransactionDiagnostics {
  const registry = enabled ? host[registryKey] : undefined;
  const singletonRegistered = Boolean(registry && registry.client === client);
  let wrapperIntact = false;
  try { wrapperIntact = Boolean(singletonRegistered && (client as TransactionClient).$transaction === registry?.wrapper); }
  catch { /* An unavailable measurement must not execute application work. */ }
  const available = Boolean(registry && singletonRegistered && wrapperIntact && !registry.invalid);
  return {
    measurement: available ? "AVAILABLE" : registry ? "INVALID" : "NOT_RUN",
    coverageScope: E2E_PRISMA_TRANSACTION_SCOPE,
    singletonRegistered, wrapperIntact,
    pendingTransactionCount: available ? registry!.pending.size : null,
    observedTransactionCount: registry?.observed ?? 0,
    settledTransactionCount: registry?.settled ?? 0,
    observedBatchTransactionCount: registry?.batch ?? 0,
    observedInteractiveTransactionCount: registry?.interactive ?? 0,
    observedOtherTransactionCount: registry?.other ?? 0,
  };
}
