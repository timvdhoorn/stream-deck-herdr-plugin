// src/core/store.test.ts
import { test, expect } from "bun:test";
import { createAgentStore } from "./store";
import type { RawAgent } from "./agents";

const six: RawAgent[] = Array.from({ length: 6 }, (_, i) => ({
  agent: "claude",
  agent_status: "working", // non-idle: idle agents are filtered out of the store
  cwd: `/x/p${i}`,
  pane_id: `w1:p${i}`,
  workspace_id: "w1",
}));

test("pollNow loads + normalizes agents and notifies subscribers", async () => {
  const store = createAgentStore({ fetchAgents: async () => six });
  const seen: number[] = [];
  store.subscribe((s) => seen.push(s.agents.length)); // initial emit = 0
  await store.pollNow();
  expect(store.getState().agents).toHaveLength(6);
  expect(seen).toEqual([0, 6]);
});

test("nextPage wraps using pageCount", async () => {
  const store = createAgentStore({ fetchAgents: async () => six });
  await store.pollNow(); // 6 agents -> 2 pages
  store.nextPage();
  expect(store.getState().page).toBe(1);
  store.nextPage();
  expect(store.getState().page).toBe(0);
});

test("a single failure keeps last-good; a second failure empties", async () => {
  let mode: "ok" | "fail" = "ok";
  const store = createAgentStore({
    fetchAgents: async () => {
      if (mode === "fail") throw new Error("herdr down");
      return six;
    },
  });
  await store.pollNow();
  expect(store.getState().agents).toHaveLength(6);
  mode = "fail";
  await store.pollNow();
  expect(store.getState().agents).toHaveLength(6); // kept
  await store.pollNow();
  expect(store.getState().agents).toHaveLength(0); // emptied
});

test("healthy is false until a fetch succeeds and after a failure wipe", async () => {
  let mode: "ok" | "fail" = "fail";
  const store = createAgentStore({
    fetchAgents: async () => {
      if (mode === "fail") throw new Error("unreachable");
      return six;
    },
  });
  expect(store.getState().healthy).toBe(false); // initial
  await store.pollNow();
  await store.pollNow();
  expect(store.getState().healthy).toBe(false); // wiped, still unhealthy
  mode = "ok";
  await store.pollNow();
  expect(store.getState().healthy).toBe(true);
  mode = "fail";
  await store.pollNow();
  expect(store.getState().healthy).toBe(true); // single failure keeps last-good
  await store.pollNow();
  expect(store.getState().healthy).toBe(false); // second failure wipes
});

test("idle agents are filtered out of the store", async () => {
  const mixed: RawAgent[] = [
    { agent: "a", agent_status: "working", cwd: "/x/a", pane_id: "w1:p1", workspace_id: "w1" },
    { agent: "b", agent_status: "idle", cwd: "/x/b", pane_id: "w1:p2", workspace_id: "w1" },
    { agent: "c", agent_status: "blocked", cwd: "/x/c", pane_id: "w1:p3", workspace_id: "w1" },
    { agent: "d", agent_status: "idle", cwd: "/x/d", pane_id: "w1:p4", workspace_id: "w1" },
  ];
  const store = createAgentStore({ fetchAgents: async () => mixed });
  await store.pollNow();
  expect(store.getState().agents.map((a) => a.paneId)).toEqual(["w1:p1", "w1:p3"]);
});

test("togglePin moves an agent to the front, keeps it when idle, cycles order", async () => {
  const mixed: RawAgent[] = [
    { agent: "a", agent_status: "working", cwd: "/x/a", pane_id: "w1:p1", workspace_id: "w1" },
    { agent: "b", agent_status: "idle", cwd: "/x/b", pane_id: "w1:p2", workspace_id: "w1" },
    { agent: "c", agent_status: "working", cwd: "/x/c", pane_id: "w1:p3", workspace_id: "w1" },
  ];
  const store = createAgentStore({ fetchAgents: async () => mixed });
  await store.pollNow();
  // idle b hidden initially
  expect(store.getState().agents.map((a) => a.paneId)).toEqual(["w1:p1", "w1:p3"]);
  // pin the idle one -> resurfaces at slot 1
  store.togglePin("w1:p2");
  expect(store.isPinned("w1:p2")).toBe(true);
  expect(store.getState().agents.map((a) => a.paneId)).toEqual(["w1:p2", "w1:p1", "w1:p3"]);
  // second pin lands next to the first (pin order)
  store.togglePin("w1:p3");
  expect(store.getState().agents.map((a) => a.paneId)).toEqual(["w1:p2", "w1:p3", "w1:p1"]);
  // unpin -> drops out of the pinned block (and idle p2 hides again)
  store.togglePin("w1:p2");
  expect(store.isPinned("w1:p2")).toBe(false);
  expect(store.getState().agents.map((a) => a.paneId)).toEqual(["w1:p3", "w1:p1"]);
});

test("page clamps when the agent list shrinks", async () => {
  let agents = six;
  const store = createAgentStore({ fetchAgents: async () => agents });
  await store.pollNow();
  store.nextPage();
  expect(store.getState().page).toBe(1);
  agents = six.slice(0, 3); // now 1 page
  await store.pollNow();
  expect(store.getState().page).toBe(0);
});

test("reset wipes to unhealthy and discards a fetch that was in flight", async () => {
  let release: (v: RawAgent[]) => void = () => {};
  let calls = 0;
  const store = createAgentStore({
    fetchAgents: () => {
      calls += 1;
      return calls === 2 ? new Promise((r) => (release = r)) : Promise.resolve(six);
    },
  });
  await store.pollNow();
  expect(store.getState().healthy).toBe(true);
  const stale = store.pollNow(); // in flight against the old server
  store.reset();
  expect(store.getState()).toMatchObject({ agents: [], healthy: false });
  const fresh = store.pollNow(); // must not be dropped as "in flight"
  release(six.slice(0, 1));
  await stale;
  await fresh;
  expect(calls).toBe(3);
  expect(store.getState().agents).toHaveLength(6); // stale 1-agent result discarded
});
