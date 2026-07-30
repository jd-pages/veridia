const e2ePort = process.env.E2E_PORT?.trim() || "3100";

export const E2E_ORIGIN = `http://localhost:${e2ePort}`;
