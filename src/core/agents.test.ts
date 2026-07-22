// src/core/agents.test.ts
import { test, expect } from "bun:test";
import { normalize, visibleAgents, orderForDisplay, labelFor, type RawAgent } from "./agents";
import fixture from "../../tests/fixtures/agent-list.json";

const raw = fixture.result.agents as RawAgent[];

test("normalize maps fields and stable-sorts by workspace then pane", () => {
  const agents = normalize(raw);
  expect(agents.map((a) => a.paneId)).toEqual(["w5:p1", "w7:p2", "wG:p1", "wJ:p1"]);
  expect(agents[0]).toEqual({
    name: "claude",
    status: "idle",
    cwd: "/Users/timvdhoorn/Devops/Logidirect/Loftware-Automation-Proxy",
    paneId: "w5:p1",
    workspaceId: "w5",
    focused: false,
    terminalTitle: "",
  });
});

test("normalize coerces unknown status and drops entries without pane_id", () => {
  const agents = normalize([
    { agent: "x", agent_status: "weird", cwd: "/a/b", pane_id: "w1:p1", workspace_id: "w1" },
    { agent: "y", agent_status: "idle", cwd: "/c" },
  ] as RawAgent[]);
  expect(agents).toHaveLength(1);
  expect(agents[0].status).toBe("unknown");
});

test("visibleAgents drops idle agents and keeps the rest in order", () => {
  const agents = normalize([
    { agent: "x", agent_status: "idle", cwd: "/a", pane_id: "w1:p1", workspace_id: "w1" },
    { agent: "y", agent_status: "working", cwd: "/b", pane_id: "w1:p2", workspace_id: "w1" },
    { agent: "z", agent_status: "blocked", cwd: "/c", pane_id: "w1:p3", workspace_id: "w1" },
    { agent: "w", agent_status: "done", cwd: "/d", pane_id: "w1:p4", workspace_id: "w1" },
    { agent: "v", agent_status: "weird", cwd: "/e", pane_id: "w1:p5", workspace_id: "w1" },
  ] as RawAgent[]);
  // idle dropped; working/blocked/done/unknown kept
  expect(visibleAgents(agents).map((a) => a.status)).toEqual([
    "working",
    "blocked",
    "done",
    "unknown",
  ]);
});

test("orderForDisplay puts pinned first in pin order, keeps pinned idle visible", () => {
  const all = normalize([
    { agent: "a", agent_status: "working", cwd: "/a", pane_id: "w1:p1", workspace_id: "w1" },
    { agent: "b", agent_status: "idle", cwd: "/b", pane_id: "w1:p2", workspace_id: "w1" },
    { agent: "c", agent_status: "blocked", cwd: "/c", pane_id: "w1:p3", workspace_id: "w1" },
  ] as RawAgent[]);
  // pin idle p2 then p1: both move to the front in pin order, idle p2 stays visible
  expect(orderForDisplay(all, ["w1:p2", "w1:p1"]).map((a) => a.paneId)).toEqual([
    "w1:p2",
    "w1:p1",
    "w1:p3",
  ]);
  // no pins: idle dropped, rest keeps order
  expect(orderForDisplay(all, []).map((a) => a.paneId)).toEqual(["w1:p1", "w1:p3"]);
  // stale pin (agent gone) is skipped
  expect(orderForDisplay(all, ["gone"]).map((a) => a.paneId)).toEqual(["w1:p1", "w1:p3"]);
});

test("labelFor uses cwd basename, truncates, disambiguates duplicates", () => {
  const agents = normalize(raw);
  const lmms = agents.find((a) => a.paneId === "w7:p2")!;
  expect(labelFor(lmms, agents)).toBe("LMManagementSystem"); // full basename (<= 24 chars)
  const dupA = { name: "c", status: "idle", cwd: "/x/app", paneId: "w1:p1", workspaceId: "w1", focused: false, terminalTitle: "" } as const;
  const dupB = { name: "c", status: "idle", cwd: "/y/app", paneId: "w2:p3", workspaceId: "w2", focused: false, terminalTitle: "" } as const;
  expect(labelFor(dupA, [dupA, dupB])).toBe("app #1");
});

test("labelFor numbers long duplicate names so they differ", () => {
  const a = { name: "claude", status: "idle", cwd: "/x/Loftware-Automation-Proxy", paneId: "w5:p1", workspaceId: "w5", focused: false, terminalTitle: "" } as const;
  const b = { name: "claude", status: "idle", cwd: "/y/Loftware-Automation-Proxy", paneId: "w5:p9", workspaceId: "w5", focused: false, terminalTitle: "" } as const;
  const la = labelFor(a, [a, b]);
  const lb = labelFor(b, [a, b]);
  expect(la.endsWith("#1")).toBe(true);
  expect(lb.endsWith("#2")).toBe(true);
  expect(la).not.toBe(lb);
  expect(la.length).toBeLessThanOrEqual(24);
});

test("normalize maps terminal_title_stripped to terminalTitle, empty when missing", () => {
  const agents = normalize([
    { agent: "x", agent_status: "working", cwd: "/a/b", pane_id: "w1:p1", workspace_id: "w1", terminal_title_stripped: "Fix login bug" },
    { agent: "y", agent_status: "working", cwd: "/c/d", pane_id: "w1:p2", workspace_id: "w1" },
  ] as RawAgent[]);
  expect(agents.find((a) => a.paneId === "w1:p1")!.terminalTitle).toBe("Fix login bug");
  expect(agents.find((a) => a.paneId === "w1:p2")!.terminalTitle).toBe("");
});

test("labelFor title mode shows the terminal title", () => {
  const a = { name: "claude", status: "working", cwd: "/x/proj", paneId: "w1:p1", workspaceId: "w1", focused: false, terminalTitle: "Fix login bug" } as const;
  expect(labelFor(a, [a], "title")).toBe("Fix login bug");
});

test("labelFor title mode truncates long titles with an ellipsis", () => {
  const longTitle = "This is an extremely long terminal title that overflows";
  const a = { name: "claude", status: "working", cwd: "/x/proj", paneId: "w1:p1", workspaceId: "w1", focused: false, terminalTitle: longTitle } as const;
  const label = labelFor(a, [a], "title");
  expect(label.length).toBeLessThanOrEqual(24);
  expect(label.endsWith("…")).toBe(true);
});

test("labelFor title mode falls back to project name when terminalTitle is empty", () => {
  const a = { name: "claude", status: "working", cwd: "/x/myproj", paneId: "w1:p1", workspaceId: "w1", focused: false, terminalTitle: "" } as const;
  expect(labelFor(a, [a], "title")).toBe("myproj");
});
