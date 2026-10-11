// src/herdr/client.test.ts
import { test, expect } from "bun:test";
import { createHerdrClient, type RunFn } from "./client";
import fixture from "../../tests/fixtures/agent-list.json";

test("listAgents runs `herdr agent list` and returns the agents array", async () => {
  const calls: string[][] = [];
  const run: RunFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return JSON.stringify(fixture);
  };
  const client = createHerdrClient({ run });
  const agents = await client.listAgents();
  expect(agents).toHaveLength(4);
  expect(calls[0]).toEqual(["herdr", "agent", "list"]);
});

test("listAgents throws on malformed shape", async () => {
  const run: RunFn = async () => JSON.stringify({ result: {} });
  const client = createHerdrClient({ run });
  await expect(client.listAgents()).rejects.toThrow();
});

test("focus runs `herdr agent focus <paneId>`", async () => {
  const calls: string[][] = [];
  const run: RunFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return "";
  };
  const client = createHerdrClient({ run });
  await client.focus("wJ:p1");
  expect(calls[0]).toEqual(["herdr", "agent", "focus", "wJ:p1"]);
});

test("socketPath getter targets the CLI via HERDR_SOCKET_PATH", async () => {
  const envs: (Record<string, string> | undefined)[] = [];
  const run: RunFn = async (_cmd, _args, extraEnv) => {
    envs.push(extraEnv);
    return "";
  };
  let sock: string | undefined;
  const client = createHerdrClient({ run, socketPath: () => sock });
  await client.focus("w1:p1");
  sock = "/tmp/fwd.sock";
  await client.focus("w1:p1");
  expect(envs).toEqual([undefined, { HERDR_SOCKET_PATH: "/tmp/fwd.sock" }]);
});

test("notify runs `herdr notification show` with body + sound", async () => {
  const calls: string[][] = [];
  const run: RunFn = async (cmd, args) => { calls.push([cmd, ...args]); return ""; };
  const client = createHerdrClient({ run });
  await client.notify("proj blocked", { body: "claude", sound: "request" });
  expect(calls[0]).toEqual(["herdr", "notification", "show", "proj blocked", "--body", "claude", "--sound", "request"]);
});
