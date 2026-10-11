import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSshTunnel,
  localSocketPath,
  parseRemoteHome,
  resolveRemoteSocket,
  sshForwardArgs,
  type ChildLike,
  type ExecFn,
  type SpawnFn,
} from "./tunnel";

test("sshForwardArgs builds a no-shell forward with option-injection guard", () => {
  const args = sshForwardArgs("me@box", "/tmp/l.sock", "/Users/me/.config/herdr/herdr.sock");
  expect(args).toEqual([
    "-N",
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-L", "/tmp/l.sock:/Users/me/.config/herdr/herdr.sock",
    "--",
    "me@box",
  ]);
});

test("resolveRemoteSocket keeps absolute paths and joins the rest onto $HOME", () => {
  expect(resolveRemoteSocket("/srv/herdr.sock", "/Users/me")).toBe("/srv/herdr.sock");
  expect(resolveRemoteSocket("~/.config/herdr/herdr.sock", "/Users/me")).toBe("/Users/me/.config/herdr/herdr.sock");
  expect(resolveRemoteSocket("custom/h.sock", "/Users/me/")).toBe("/Users/me/custom/h.sock");
  expect(resolveRemoteSocket(undefined, "/Users/me")).toBe("/Users/me/.config/herdr/herdr.sock");
  expect(resolveRemoteSocket("  ", "/Users/me")).toBe("/Users/me/.config/herdr/herdr.sock");
});

test("localSocketPath is per-pid and per-tunnel", () => {
  expect(localSocketPath(1)).not.toBe(localSocketPath(2));
  expect(localSocketPath(1)).not.toBe(localSocketPath(1));
});

test("parseRemoteHome tolerates rc-file noise and rejects garbage", () => {
  expect(parseRemoteHome("/Users/me\n")).toBe("/Users/me");
  expect(parseRemoteHome("welcome to zsh!\nnvm loaded\n/home/me\n")).toBe("/home/me");
  expect(() => parseRemoteHome("")).toThrow();
  expect(() => parseRemoteHome("permission denied")).toThrow();
});

function fakeChild(): ChildLike & { exitFns: (() => void)[]; killed: boolean } {
  const c = {
    exitFns: [] as (() => void)[],
    killed: false,
    on(_: "exit", fn: () => void) {
      c.exitFns.push(fn);
    },
    kill() {
      c.killed = true;
    },
  };
  return c;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("tunnel resolves remote $HOME once, then spawns the forward", async () => {
  const execCalls: string[][] = [];
  const exec: ExecFn = async (cmd, args) => {
    execCalls.push([cmd, ...args]);
    return "/Users/me\n";
  };
  const spawned: string[][] = [];
  const child = fakeChild();
  const spawn: SpawnFn = (cmd, args) => {
    spawned.push([cmd, ...args]);
    return child;
  };
  const t = createSshTunnel({ target: "me@box", spawn, exec, localSocket: "/tmp/t1.sock" });
  t.start();
  await tick();
  expect(execCalls).toEqual([["ssh", "-o", "BatchMode=yes", "--", "me@box", 'echo "$HOME"']]);
  expect(spawned).toEqual([["ssh", ...sshForwardArgs("me@box", "/tmp/t1.sock", "/Users/me/.config/herdr/herdr.sock")]]);
  t.stop();
  expect(child.killed).toBe(true);
});

test("tunnel skips the $HOME round-trip for an absolute configured path", async () => {
  let execs = 0;
  const exec: ExecFn = async () => {
    execs += 1;
    return "/Users/me";
  };
  const spawned: string[][] = [];
  const spawn: SpawnFn = (cmd, args) => {
    spawned.push([cmd, ...args]);
    return fakeChild();
  };
  const t = createSshTunnel({
    target: "box",
    remoteSocketPath: "/srv/h.sock",
    spawn,
    exec,
    localSocket: "/tmp/t2.sock",
  });
  t.start();
  await tick();
  expect(execs).toBe(0);
  expect(spawned[0]).toContain("/tmp/t2.sock:/srv/h.sock");
  t.stop();
});

test("tunnel reports a failed $HOME resolution and retries later", async () => {
  const errors: string[] = [];
  const exec: ExecFn = async () => {
    throw new Error("auth failed");
  };
  let spawns = 0;
  const spawn: SpawnFn = () => {
    spawns += 1;
    return fakeChild();
  };
  const t = createSshTunnel({
    target: "box",
    spawn,
    exec,
    localSocket: "/tmp/t3.sock",
    onError: (m) => errors.push(m),
  });
  t.start();
  await tick();
  expect(spawns).toBe(0);
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain("auth failed");
  t.stop();
});

test("tunnel respawns after the ssh process exits", async () => {
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawn: SpawnFn = () => {
    const c = fakeChild();
    children.push(c);
    return c;
  };
  const t = createSshTunnel({
    target: "box",
    remoteSocketPath: "/srv/h.sock",
    spawn,
    localSocket: "/tmp/t4.sock",
  });
  t.start();
  await tick();
  expect(children.length).toBe(1);
  children[0]!.exitFns.forEach((fn) => fn());
  // first restart uses the minimum backoff (1s)
  await new Promise((r) => setTimeout(r, 1100));
  expect(children.length).toBe(2);
  t.stop();
});

test("stop aborts an in-flight remote-home probe", async () => {
  let seen: AbortSignal | undefined;
  const exec: ExecFn = (_cmd, _args, signal) => {
    seen = signal;
    return new Promise(() => {}); // hangs like ssh against an unreachable host
  };
  const t = createSshTunnel({ target: "box", exec, spawn: () => fakeChild(), localSocket: "/tmp/t6.sock" });
  t.start();
  await tick();
  expect(seen).toBeDefined();
  expect(seen!.aborted).toBe(false);
  t.stop();
  expect(seen!.aborted).toBe(true);
});

test("onUp fires once ssh binds the local socket", async () => {
  const sock = path.join(os.tmpdir(), `tunnel-test-up-${process.pid}.sock`);
  fs.rmSync(sock, { force: true });
  let up = 0;
  const t = createSshTunnel({
    target: "box",
    remoteSocketPath: "/srv/h.sock",
    spawn: () => fakeChild(),
    localSocket: sock,
    onUp: () => {
      up += 1;
    },
  });
  t.start();
  await new Promise((r) => setTimeout(r, 250));
  expect(up).toBe(0); // socket not bound yet
  fs.writeFileSync(sock, ""); // stand-in for ssh binding the socket
  await new Promise((r) => setTimeout(r, 450));
  expect(up).toBe(1);
  t.stop();
  fs.rmSync(sock, { force: true });
});

test("stopped tunnel does not respawn on a late exit", async () => {
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawn: SpawnFn = () => {
    const c = fakeChild();
    children.push(c);
    return c;
  };
  const t = createSshTunnel({
    target: "box",
    remoteSocketPath: "/srv/h.sock",
    spawn,
    localSocket: "/tmp/t5.sock",
  });
  t.start();
  await tick();
  t.stop();
  children[0]!.exitFns.forEach((fn) => fn());
  await new Promise((r) => setTimeout(r, 1100));
  expect(children.length).toBe(1);
});
