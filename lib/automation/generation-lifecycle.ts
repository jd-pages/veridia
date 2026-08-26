import type { AutomationPlatform } from "./platform";

export type GenerationLifecycleIdentity = {
  platform: AutomationPlatform;
  batchId: string;
  taskId: string;
  runEpoch: number;
  claimEpoch: number;
  ownerGeneration: number;
  wakeGeneration: number | null;
};

export type ExtractionLifecycleState =
  | "RUNNING"
  | "ABORT_REQUESTED"
  | "SETTLING"
  | "SETTLED";

export type OwnedExtractionHandle = GenerationLifecycleIdentity & {
  signal: AbortSignal;
  state: ExtractionLifecycleState;
  startedAt: string;
  abortRequestedAt: string | null;
  settledAt: string | null;
  settled: Promise<void>;
  abort: () => void;
};

type InternalExtractionHandle = OwnedExtractionHandle & {
  controller: AbortController;
  resolveSettled: () => void;
};

type CleanupBarrier = {
  identity: GenerationLifecycleIdentity;
  createdAt: string;
  promise: Promise<void>;
};

export type GenerationLifecycleEventName =
  | "EXTRACTION_STARTED"
  | "EXTRACTION_ABORT_REQUESTED"
  | "EXTRACTION_SETTLED"
  | "CLEANUP_BARRIER_CREATED"
  | "CLEANUP_BARRIER_WAIT_START"
  | "CLEANUP_BARRIER_WAIT_END"
  | "BROWSER_OWNER_ACQUIRED"
  | "BROWSER_OWNER_RELEASED"
  | "STALE_BROWSER_CLEANUP_REJECTED"
  | "STALE_EXTRACTION_ERROR_IGNORED";

type GenerationLifecycleEvent = {
  event: GenerationLifecycleEventName;
  occurredAt: string;
  identity: GenerationLifecycleIdentity;
};

type GenerationLifecycleState = {
  nextOwnerGeneration: number;
  activeExtractions: Map<number, InternalExtractionHandle>;
  cleanupBarriers: Map<AutomationPlatform, CleanupBarrier>;
  browserOwners: Map<AutomationPlatform, GenerationLifecycleIdentity>;
  events: GenerationLifecycleEvent[];
};

const globalForLifecycle = globalThis as typeof globalThis & {
  automationGenerationLifecycleState?: GenerationLifecycleState;
};

const initialState: GenerationLifecycleState = {
  nextOwnerGeneration: 0,
  activeExtractions: new Map(),
  cleanupBarriers: new Map(),
  browserOwners: new Map(),
  events: [],
};

const state =
  globalForLifecycle.automationGenerationLifecycleState ??
  (globalForLifecycle.automationGenerationLifecycleState = initialState);

function lifecycleLog(
  event: GenerationLifecycleEventName,
  identity: GenerationLifecycleIdentity,
) {
  const lifecycleIdentity: GenerationLifecycleIdentity = {
    platform: identity.platform,
    batchId: identity.batchId,
    taskId: identity.taskId,
    runEpoch: identity.runEpoch,
    claimEpoch: identity.claimEpoch,
    ownerGeneration: identity.ownerGeneration,
    wakeGeneration: identity.wakeGeneration,
  };
  const entry = {
    event,
    occurredAt: new Date().toISOString(),
    identity: lifecycleIdentity,
  };
  state.events.push(entry);
  if (state.events.length > 100) state.events.splice(0, state.events.length - 100);
  console.info(
    "[自动审核生命周期] " + event,
    JSON.stringify(lifecycleIdentity),
  );
}

export function recordGenerationLifecycleEvent(
  event: GenerationLifecycleEventName,
  identity: GenerationLifecycleIdentity,
) {
  lifecycleLog(event, identity);
}

export function startOwnedExtraction(input: {
  platform: AutomationPlatform;
  batchId: string;
  taskId: string;
  runEpoch: number;
  claimEpoch: number;
  wakeGeneration?: number;
}) {
  const controller = new AbortController();
  let resolveSettled: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const handle: InternalExtractionHandle = {
    ...input,
    ownerGeneration: ++state.nextOwnerGeneration,
    wakeGeneration: input.wakeGeneration ?? null,
    signal: controller.signal,
    controller,
    state: "RUNNING",
    startedAt: new Date().toISOString(),
    abortRequestedAt: null,
    settledAt: null,
    settled,
    resolveSettled,
    abort: () => controller.abort(),
  };
  state.activeExtractions.set(handle.ownerGeneration, handle);
  lifecycleLog("EXTRACTION_STARTED", handle);
  return handle as OwnedExtractionHandle;
}

export function trackOwnedExtraction<T>(
  handle: OwnedExtractionHandle,
  operation: Promise<T>,
) {
  void operation.then(
    () => settleOwnedExtraction(handle),
    () => settleOwnedExtraction(handle),
  );
  return operation;
}

export function settleOwnedExtraction(handle: OwnedExtractionHandle) {
  const active = state.activeExtractions.get(handle.ownerGeneration);
  if (!active || active.state === "SETTLED") return;
  active.state = "SETTLED";
  active.settledAt = new Date().toISOString();
  state.activeExtractions.delete(active.ownerGeneration);
  lifecycleLog("EXTRACTION_SETTLED", active);
  active.resolveSettled();
}

export function requestOwnedExtractionCancellation(
  handle: OwnedExtractionHandle,
  cleanup: (identity: GenerationLifecycleIdentity) => Promise<void>,
) {
  const existing = state.cleanupBarriers.get(handle.platform);
  if (
    existing &&
    existing.identity.ownerGeneration === handle.ownerGeneration
  ) {
    return existing.promise;
  }
  const active = state.activeExtractions.get(handle.ownerGeneration);
  if (!active) return Promise.resolve();
  if (active.state === "RUNNING") {
    active.state = "ABORT_REQUESTED";
    active.abortRequestedAt = new Date().toISOString();
    lifecycleLog("EXTRACTION_ABORT_REQUESTED", active);
    active.controller.abort();
  }
  const barrier: CleanupBarrier = {
    identity: active,
    createdAt: new Date().toISOString(),
    promise: Promise.resolve(),
  };
  barrier.promise = (async () => {
    active.state = "SETTLING";
    try {
      await cleanup(active);
    } finally {
      await active.settled;
    }
  })().finally(() => {
    if (state.cleanupBarriers.get(active.platform) === barrier) {
      state.cleanupBarriers.delete(active.platform);
    }
  });
  state.cleanupBarriers.set(active.platform, barrier);
  lifecycleLog("CLEANUP_BARRIER_CREATED", active);
  return barrier.promise;
}

export async function waitForOwnedExtractionCleanup(
  platform: AutomationPlatform,
  waitingIdentity: Omit<GenerationLifecycleIdentity, "ownerGeneration">,
) {
  const barrier = state.cleanupBarriers.get(platform);
  if (!barrier) return;
  const identity: GenerationLifecycleIdentity = {
    ...waitingIdentity,
    ownerGeneration: barrier.identity.ownerGeneration,
  };
  lifecycleLog("CLEANUP_BARRIER_WAIT_START", identity);
  await barrier.promise;
  lifecycleLog("CLEANUP_BARRIER_WAIT_END", identity);
}

export function acquireBrowserOwner(identity: GenerationLifecycleIdentity) {
  const previous = state.browserOwners.get(identity.platform);
  if (previous?.ownerGeneration === identity.ownerGeneration) return;
  if (previous) lifecycleLog("BROWSER_OWNER_RELEASED", previous);
  state.browserOwners.set(identity.platform, identity);
  lifecycleLog("BROWSER_OWNER_ACQUIRED", identity);
}

export function releaseBrowserOwner(identity: GenerationLifecycleIdentity) {
  const current = state.browserOwners.get(identity.platform);
  if (current?.ownerGeneration !== identity.ownerGeneration) return false;
  state.browserOwners.delete(identity.platform);
  lifecycleLog("BROWSER_OWNER_RELEASED", identity);
  return true;
}

export function isCurrentBrowserOwner(identity: GenerationLifecycleIdentity) {
  return (
    state.browserOwners.get(identity.platform)?.ownerGeneration ===
    identity.ownerGeneration
  );
}

export function authorizeBrowserCleanup(identity: GenerationLifecycleIdentity) {
  if (isCurrentBrowserOwner(identity)) return true;
  lifecycleLog("STALE_BROWSER_CLEANUP_REJECTED", identity);
  return false;
}

export function isStaleExtractionCompletion(handle: OwnedExtractionHandle) {
  return (
    handle.signal.aborted ||
    !state.activeExtractions.has(handle.ownerGeneration)
  );
}

export function getGenerationLifecycleDiagnostics(platform?: AutomationPlatform) {
  const active = [...state.activeExtractions.values()].filter(
    (entry) => !platform || entry.platform === platform,
  );
  const barriers = [...state.cleanupBarriers.values()].filter(
    (entry) => !platform || entry.identity.platform === platform,
  );
  const browserOwners = [...state.browserOwners.values()].filter(
    (entry) => !platform || entry.platform === platform,
  );
  return {
    activeExtractionCount: active.length,
    pendingCleanupBarrierCount: barriers.length,
    activeBrowserOwnerGenerations: browserOwners.map(
      (entry) => entry.ownerGeneration,
    ),
    activeExtractions: active.map((entry) => ({
      batchId: entry.batchId,
      taskId: entry.taskId,
      runEpoch: entry.runEpoch,
      claimEpoch: entry.claimEpoch,
      ownerGeneration: entry.ownerGeneration,
      wakeGeneration: entry.wakeGeneration,
      startedAt: entry.startedAt,
      abortRequestedAt: entry.abortRequestedAt,
      settledAt: entry.settledAt,
      state: entry.state,
    })),
    recentEvents: state.events
      .filter((entry) => !platform || entry.identity.platform === platform)
      .slice(-30),
  };
}

export function resetGenerationLifecycleForTesting() {
  for (const entry of state.activeExtractions.values()) entry.controller.abort();
  state.nextOwnerGeneration = 0;
  state.activeExtractions.clear();
  state.cleanupBarriers.clear();
  state.browserOwners.clear();
  state.events.length = 0;
}
