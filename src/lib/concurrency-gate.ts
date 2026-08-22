type PendingJob = () => void;

type GateState = {
  active: number;
  maximum: number;
  pending: PendingJob[];
};

const registryKey = Symbol.for("scenelith.concurrency-gates");

function registry() {
  const root = globalThis as typeof globalThis & { [registryKey]?: Map<string, GateState> };
  if (!root[registryKey]) root[registryKey] = new Map();
  return root[registryKey];
}

export function concurrencyGate(name: string, maximum: number) {
  const safeMaximum = Math.max(1, Math.floor(maximum));
  const gates = registry();
  const state = gates.get(name) || { active: 0, maximum: safeMaximum, pending: [] };
  state.maximum = safeMaximum;
  gates.set(name, state);

  const acquire = () => new Promise<void>((resolve) => {
    if (state.active < state.maximum) {
      state.active += 1;
      resolve();
      return;
    }
    state.pending.push(() => {
      state.active += 1;
      resolve();
    });
  });

  const release = () => {
    state.active = Math.max(0, state.active - 1);
    state.pending.shift()?.();
  };

  return async function runWithGate<T>(job: () => Promise<T>) {
    await acquire();
    try {
      return await job();
    } finally {
      release();
    }
  };
}
