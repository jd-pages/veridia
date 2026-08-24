export type RunnerHandoffState = {
  wakeGeneration?: number;
  runnerGeneration?: number;
};

export function requestRunnerWake(state: RunnerHandoffState) {
  state.wakeGeneration = (state.wakeGeneration ?? 0) + 1;
  return state.wakeGeneration;
}

export function claimRunnerWake(state: RunnerHandoffState) {
  if (state.runnerGeneration !== undefined) return null;
  const generation = state.wakeGeneration ?? 0;
  state.runnerGeneration = generation;
  return generation;
}

export function completeRunnerWake(
  state: RunnerHandoffState,
  generation: number,
) {
  if (state.runnerGeneration !== generation) return false;
  state.runnerGeneration = undefined;
  return (state.wakeGeneration ?? 0) > generation;
}
