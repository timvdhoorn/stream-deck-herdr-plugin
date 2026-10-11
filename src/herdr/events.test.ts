import { test, expect } from "bun:test";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHerdrEvents, createRelevanceFilter, feedLines, herdrSocketPath } from "./events";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listen = (srv: net.Server, sock: string) => new Promise<void>((r) => srv.listen(sock, r));

// Note: both tests keep a live server for every connect. bun's test runner
// (1.3.x) fails a test on any unix-socket connect error even when the socket
// has an error handler, so a deliberately-failing connect can't be exercised
// here; the reconnect-after-drop path below covers the same timer logic.
test("stop cancels a pending reconnect for good", async () => {
  const sock = path.join(os.tmpdir(), `ev-test-stop-${process.pid}.sock`);
  fs.rmSync(sock, { force: true });
  let conns = 0;
  const clients: net.Socket[] = [];
  const srv = net.createServer((c) => {
    conns += 1;
    clients.push(c);
  });
  await listen(srv, sock);
  const ev = createHerdrEvents({ onChange: () => {}, socketPath: sock });
  ev.start();
  await sleep(150);
  expect(conns).toBe(1);
  clients.forEach((c) => c.destroy()); // server-side drop -> client schedules reconnect (1s)
  await sleep(100);
  ev.stop(); // must cancel that pending reconnect
  await sleep(1300); // past the reconnect backoff
  expect(conns).toBe(1);
  srv.close();
  fs.rmSync(sock, { force: true });
});

test("stop+start (tunnel-recovery kick) never accumulates connections", async () => {
  const sock = path.join(os.tmpdir(), `ev-test-kick-${process.pid}.sock`);
  fs.rmSync(sock, { force: true });
  let active = 0;
  const srv = net.createServer((c) => {
    active += 1;
    c.on("close", () => {
      active -= 1;
    });
  });
  await listen(srv, sock);
  const ev = createHerdrEvents({ onChange: () => {}, socketPath: sock });
  ev.start();
  await sleep(150);
  ev.stop();
  ev.start(); // the onUp kick
  await sleep(1300); // give stray timers/close callbacks every chance to misfire
  expect(active).toBe(1);
  ev.stop();
  srv.close();
  fs.rmSync(sock, { force: true });
});

const updated = (pane: Record<string, unknown>) =>
  JSON.stringify({ data: { pane, type: "pane_updated" }, event: "pane_updated" });

test("relevance filter: acks and lifecycle events always refresh", () => {
  const relevant = createRelevanceFilter();
  expect(relevant('{"id":"sd-sub","result":{"type":"subscription_started"}}')).toBe(true);
  expect(relevant('{"data":{"pane_id":"w1:p1","type":"pane_agent_detected"},"event":"pane_agent_detected"}')).toBe(true);
  expect(relevant('{"data":{"pane":{"pane_id":"w2:p1"},"type":"pane_created"},"event":"pane_created"}')).toBe(true);
  expect(relevant("not json")).toBe(true);
});

test("relevance filter: pane_updated refreshes only when agent/status/cwd change", () => {
  const relevant = createRelevanceFilter();
  const base = { pane_id: "w1:p1", agent: "claude", agent_status: "working", cwd: "/p", terminal_title: "t1" };
  expect(relevant(updated(base))).toBe(true); // first sighting
  expect(relevant(updated({ ...base, terminal_title: "t2", scroll: 5 }))).toBe(false); // noise
  expect(relevant(updated({ ...base, agent_status: "blocked" }))).toBe(true); // status flip
  expect(relevant(updated({ ...base, agent_status: "blocked" }))).toBe(false);
  expect(relevant(updated({ ...base, pane_id: "w2:p1" }))).toBe(true); // other pane tracked separately
});

test("relevance filter: pane close forgets the fingerprint", () => {
  const relevant = createRelevanceFilter();
  const pane = { pane_id: "w1:p1", agent: "claude", agent_status: "working", cwd: "/p" };
  expect(relevant(updated(pane))).toBe(true);
  expect(relevant('{"data":{"pane_id":"w1:p1","type":"pane_closed"},"event":"pane_closed"}')).toBe(true);
  expect(relevant(updated(pane))).toBe(true); // reappearing pane refreshes again
});

test("feedLines returns complete lines and keeps the partial remainder", () => {
  const a = feedLines("", '{"a":1}\n{"b":2}\n{"c"');
  expect(a.lines).toEqual(['{"a":1}', '{"b":2}']);
  expect(a.rest).toBe('{"c"');
  const b = feedLines(a.rest, ':3}\n');
  expect(b.lines).toEqual(['{"c":3}']);
  expect(b.rest).toBe("");
});

test("feedLines drops blank lines", () => {
  expect(feedLines("", "\n\n").lines).toEqual([]);
});

test("herdrSocketPath honors HERDR_SOCKET_PATH then falls back to the default", () => {
  const prev = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = "/tmp/x.sock";
  expect(herdrSocketPath()).toBe("/tmp/x.sock");
  delete process.env.HERDR_SOCKET_PATH;
  expect(herdrSocketPath().endsWith("/.config/herdr/herdr.sock")).toBe(true);
  if (prev !== undefined) process.env.HERDR_SOCKET_PATH = prev;
});
