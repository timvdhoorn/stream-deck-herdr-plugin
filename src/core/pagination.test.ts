// src/core/pagination.test.ts
import { test, expect } from "bun:test";
import {
  PAGE_SIZE,
  pageCount,
  clampPage,
  pageSlice,
  offPageWorstAttention,
  offPageAttentionCount,
  attentionAgents,
  worstAttention,
} from "./pagination";
import type { Agent } from "./agents";

const mk = (status: Agent["status"], paneId: string): Agent => ({
  name: "claude",
  status,
  cwd: "/x/proj",
  paneId,
  workspaceId: "w1",
  focused: false,
  terminalTitle: "",
});

test("PAGE_SIZE is 5 and pageCount has a floor of 1", () => {
  expect(PAGE_SIZE).toBe(5);
  expect(pageCount(0)).toBe(1);
  expect(pageCount(5)).toBe(1);
  expect(pageCount(6)).toBe(2);
  expect(pageCount(11)).toBe(3);
});

test("clampPage keeps page inside range", () => {
  expect(clampPage(2, 1)).toBe(0);
  expect(clampPage(-1, 3)).toBe(0);
  expect(clampPage(5, 3)).toBe(2);
});

test("pageSlice returns the window for a page", () => {
  const agents = ["a", "b", "c", "d", "e", "f"].map((p) => mk("idle", p));
  expect(pageSlice(agents, 1).map((a) => a.paneId)).toEqual(["f"]);
});

test("offPageWorstAttention ranks blocked > done and ignores working + on-page", () => {
  const agents = [
    ...["p0", "p1", "p2", "p3", "p4"].map((p) => mk("idle", p)), // page 0
    mk("working", "p5"),
    mk("done", "p6"),
    mk("blocked", "p7"),
  ];
  expect(offPageWorstAttention(agents, 0)).toBe("blocked");
  // working is NOT a notify state, so only done + blocked count
  expect(offPageAttentionCount(agents, 0)).toBe(2);
  // when the blocked agent is on the current page, it no longer counts off-page
  expect(offPageWorstAttention(agents, 1)).toBe(null);
});

test("working off-page never raises the pager badge", () => {
  const agents = [
    ...["p0", "p1", "p2", "p3", "p4"].map((p) => mk("idle", p)),
    mk("working", "p5"),
    mk("working", "p6"),
  ];
  expect(offPageWorstAttention(agents, 0)).toBe(null);
  expect(offPageAttentionCount(agents, 0)).toBe(0);
});

test("idle/unknown off-page produce no badge", () => {
  const agents = [
    ...["p0", "p1", "p2", "p3", "p4"].map((p) => mk("working", p)),
    mk("idle", "p5"),
    mk("unknown", "p6"),
  ];
  expect(offPageWorstAttention(agents, 0)).toBe(null);
  expect(offPageAttentionCount(agents, 0)).toBe(0);
});

test("attentionAgents keeps only blocked/done in order", () => {
  const agents = [mk("working", "p0"), mk("blocked", "p1"), mk("idle", "p2"), mk("done", "p3")];
  expect(attentionAgents(agents).map((a) => a.paneId)).toEqual(["p1", "p3"]);
});

test("worstAttention is blocked > done > null", () => {
  expect(worstAttention([mk("done", "p0"), mk("blocked", "p1")])).toBe("blocked");
  expect(worstAttention([mk("done", "p0")])).toBe("done");
  expect(worstAttention([mk("working", "p0"), mk("idle", "p1")])).toBe(null);
});
