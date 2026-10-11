// src/core/store.ts
import { normalize, orderForDisplay, type Agent, type RawAgent } from "./agents";
import { clampPage, pageCount } from "./pagination";

// `healthy` is true only while the agent list reflects a successful fetch —
// false initially and after a failure wipe, so consumers can tell "empty
// because the server is unreachable" from "genuinely no agents".
export type StoreState = { agents: Agent[]; page: number; healthy: boolean };

export type AgentStore = {
  getState(): StoreState;
  subscribe(fn: (s: StoreState) => void): () => void;
  setPage(next: number): void;
  nextPage(): void;
  togglePin(paneId: string): void;
  isPinned(paneId: string): boolean;
  pollNow(): Promise<void>;
  reset(): void;
  start(intervalMs?: number): void;
  stop(): void;
};

export function createAgentStore(opts: {
  fetchAgents: () => Promise<RawAgent[]>;
  pageSize?: number;
}): AgentStore {
  const pageSize = opts.pageSize ?? 5;
  let state: StoreState = { agents: [], page: 0, healthy: false };
  // Full normalized list (includes idle) so pinned-idle agents can resurface;
  // `pinned` is paneIds in pin order (in-memory, reset on plugin restart).
  let allAgents: Agent[] = [];
  let pinned: string[] = [];
  let hasLastGood = false;
  let failStreak = 0;
  let inFlight = false;
  // Bumped by reset(): a fetch that started before it belongs to the previous
  // connection and its result is discarded.
  let generation = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const subs = new Set<(s: StoreState) => void>();

  const emit = () => subs.forEach((fn) => fn(state));
  const set = (next: Partial<StoreState>) => {
    state = { ...state, ...next };
    emit();
  };
  // Re-derive the displayed list (pinned-first, idle hidden) from the current
  // raw list + pins, clamping the page to the new length.
  const recompute = (extra: Partial<StoreState> = {}) => {
    const agents = orderForDisplay(allAgents, pinned);
    set({ ...extra, agents, page: clampPage(state.page, pageCount(agents.length, pageSize)) });
  };

  const store: AgentStore = {
    getState: () => state,
    subscribe(fn) {
      subs.add(fn);
      fn(state);
      return () => {
        subs.delete(fn);
      };
    },
    setPage(next) {
      set({ page: clampPage(next, pageCount(state.agents.length, pageSize)) });
    },
    nextPage() {
      const pages = pageCount(state.agents.length, pageSize);
      set({ page: (state.page + 1) % pages });
    },
    togglePin(paneId) {
      pinned = pinned.includes(paneId)
        ? pinned.filter((id) => id !== paneId)
        : [...pinned, paneId];
      recompute();
    },
    isPinned: (paneId) => pinned.includes(paneId),
    async pollNow() {
      if (inFlight) return;
      inFlight = true;
      const gen = generation;
      try {
        const fetched = normalize(await opts.fetchAgents());
        if (gen !== generation) return;
        allAgents = fetched;
        hasLastGood = true;
        failStreak = 0;
        recompute({ healthy: true });
      } catch {
        if (gen !== generation) return;
        failStreak += 1;
        if (!(failStreak === 1 && hasLastGood)) {
          hasLastGood = false;
          allAgents = [];
          recompute({ healthy: false });
        }
      } finally {
        if (gen === generation) inFlight = false;
      }
    },
    // Forget everything fetched so far (the connection now points at another
    // server): an empty, unhealthy snapshot until the next successful fetch.
    reset() {
      generation += 1;
      inFlight = false;
      hasLastGood = false;
      failStreak = 0;
      allAgents = [];
      recompute({ healthy: false });
    },
    start(intervalMs = 1000) {
      if (timer) return;
      void store.pollNow();
      timer = setInterval(() => void store.pollNow(), intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };

  return store;
}
