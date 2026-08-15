interface AuditReadQueueState {
  active: boolean;
  waiting: Array<() => void>;
}

const globalForAuditReads = globalThis as typeof globalThis & {
  auditReadQueueState?: AuditReadQueueState;
};

function isSqliteRuntime() {
  return process.env.DATABASE_URL?.trim().startsWith("file:") ?? false;
}

async function acquireSqliteAuditReadSlot() {
  const state = globalForAuditReads.auditReadQueueState ??= {
    active: false,
    waiting: [],
  };
  if (!state.active) {
    state.active = true;
    return;
  }
  await new Promise<void>((resolve) => state.waiting.push(resolve));
}

function releaseSqliteAuditReadSlot() {
  const state = globalForAuditReads.auditReadQueueState;
  if (!state) return;
  const next = state.waiting.shift();
  if (next) next();
  else state.active = false;
}

export async function withHeavyAuditReadSlot<T>(task: () => Promise<T>) {
  if (!isSqliteRuntime()) return task();
  await acquireSqliteAuditReadSlot();
  try {
    return await task();
  } finally {
    releaseSqliteAuditReadSlot();
  }
}
