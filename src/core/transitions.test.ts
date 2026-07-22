// src/core/transitions.test.ts
import { test, expect } from "bun:test";
import { detectFlips } from "./transitions";
import type { Agent } from "./agents";

const mk = (status: Agent["status"], paneId: string): Agent => ({
  name: "claude", status, cwd: "/x/proj", paneId, workspaceId: "w1", focused: false, terminalTitle: "",
});

test("detects transitions into blocked/done", () => {
  const prev = [mk("working", "p1"), mk("blocked", "p2"), mk("idle", "p3")];
  const next = [mk("blocked", "p1"), mk("blocked", "p2"), mk("done", "p3")];
  expect(detectFlips(prev, next).map((a) => a.paneId)).toEqual(["p1", "p3"]);
});

test("new agent already blocked/done counts as a flip", () => {
  expect(detectFlips([], [mk("done", "p9")]).map((a) => a.paneId)).toEqual(["p9"]);
});

test("leaving an attention state is not a flip", () => {
  expect(detectFlips([mk("blocked", "p1")], [mk("idle", "p1")])).toEqual([]);
});
