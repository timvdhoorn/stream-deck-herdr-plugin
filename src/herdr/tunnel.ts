// src/herdr/tunnel.ts
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execText } from "./client";

const RESTART_MIN_MS = 1000;
const RESTART_MAX_MS = 30000;
// A tunnel that stayed up this long is considered healthy; the restart backoff
// resets so a later drop reconnects quickly again.
const HEALTHY_AFTER_MS = 30000;
// How often to check whether ssh has bound the local socket. Watching lasts as
// long as the ssh process does: a slow first auth must still signal readiness.
const UP_POLL_MS = 200;

export const DEFAULT_REMOTE_SOCKET = ".config/herdr/herdr.sock";

// Where the forwarded socket lives on this machine. Per-pid so two plugin
// instances (e.g. dev + installed) never fight over one socket file, and
// per-tunnel within a process: a dying ssh unlinks its local socket on exit,
// which must never race with a replacement tunnel bound to the same path.
let tunnelSeq = 0;
export function localSocketPath(pid: number = process.pid, seq: number = tunnelSeq++): string {
  return path.join(os.tmpdir(), `herdr-deck-${pid}-${seq}.sock`);
}

// argv for the forwarding ssh process. No shell is involved anywhere (spawn
// with an args array), and `--` stops option parsing so a target from settings
// can never inject ssh options.
export function sshForwardArgs(target: string, localSock: string, remoteSock: string): string[] {
  return [
    "-N",
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-L", `${localSock}:${remoteSock}`,
    "--",
    target,
  ];
}

// sshd resolves the remote end of a `-L` unix-socket forward as a plain path,
// so it must be absolute. A configured absolute path wins (no $HOME needed);
// anything else (including the default) is joined onto the remote $HOME.
export function isAbsoluteRemote(configured: string | undefined): boolean {
  return configured?.trim().startsWith("/") ?? false;
}

export function resolveRemoteSocket(configured: string | undefined, remoteHome: string): string {
  const p = configured?.trim() ? configured.trim() : DEFAULT_REMOTE_SOCKET;
  if (p.startsWith("/")) return p;
  const rel = p.startsWith("~/") ? p.slice(2) : p;
  return `${remoteHome.replace(/\/$/, "")}/${rel}`;
}

// Non-interactive ssh sources the remote rc files, which may echo noise (shell
// greetings, tool init) before our marker — the remote $HOME is the last
// non-empty line that looks like an absolute path.
export function parseRemoteHome(stdout: string): string {
  const home = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .pop();
  if (home === undefined || !home.startsWith("/")) {
    throw new Error(`unexpected remote $HOME output: ${JSON.stringify(stdout.slice(0, 200))}`);
  }
  return home;
}

export type SpawnFn = (cmd: string, args: string[]) => ChildLike;
export type ChildLike = {
  on(event: "exit", fn: () => void): void;
  kill(): void;
};

export type ExecFn = (cmd: string, args: string[], signal?: AbortSignal) => Promise<string>;

// A spawn failure (ssh missing, EAGAIN) emits "error" instead of "exit"; an
// unhandled "error" would crash the plugin, so both end the child exactly once.
const defaultSpawn: SpawnFn = (cmd, args) => {
  const c = nodeSpawn(cmd, args, { stdio: "ignore" });
  return {
    on(_event, fn) {
      let ended = false;
      const end = (): void => {
        if (ended) return;
        ended = true;
        fn();
      };
      c.on("exit", end);
      c.on("error", end);
    },
    kill: () => c.kill(),
  };
};

const defaultExec: ExecFn = (cmd, args, signal) => execText(cmd, args, { timeoutMs: 15000, signal });

export type Tunnel = {
  readonly localSocket: string;
  start(): void;
  stop(): void;
};

// Keeps `ssh -N -L <local>:<remote>` alive: resolves the remote socket path
// (one `echo $HOME` round-trip unless an absolute path is configured), spawns
// the forward, and respawns with exponential backoff whenever it exits.
// onUp fires each time the forward binds the local socket, so consumers can
// (re)connect immediately instead of sitting out their own retry backoff.
// Never throws; failures are reported via onError and retried.
export function createSshTunnel(opts: {
  target: string;
  remoteSocketPath?: string;
  onUp?: () => void;
  onError?: (message: string) => void;
  spawn?: SpawnFn;
  exec?: ExecFn;
  localSocket?: string;
}): Tunnel {
  const spawn = opts.spawn ?? defaultSpawn;
  const exec = opts.exec ?? defaultExec;
  const localSock = opts.localSocket ?? localSocketPath();
  const onError = opts.onError ?? (() => {});

  let stopped = false;
  let child: ChildLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let upWatch: ReturnType<typeof setInterval> | null = null;
  let probe: AbortController | null = null;
  let backoff = RESTART_MIN_MS;
  let remoteSock: string | null = null;

  const removeLocalSock = (): void => {
    // ssh refuses to bind over a leftover socket file from a previous run.
    try {
      fs.rmSync(localSock, { force: true });
    } catch {
      /* stale-file cleanup is best-effort */
    }
  };

  const clearUpWatch = (): void => {
    if (upWatch) {
      clearInterval(upWatch);
      upWatch = null;
    }
  };

  const watchForUp = (): void => {
    clearUpWatch();
    upWatch = setInterval(() => {
      if (stopped) {
        clearUpWatch();
        return;
      }
      if (fs.existsSync(localSock)) {
        clearUpWatch();
        opts.onUp?.();
      }
    }, UP_POLL_MS);
  };

  const scheduleRestart = (): void => {
    if (stopped || timer) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, RESTART_MAX_MS);
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, wait);
  };

  const connect = async (): Promise<void> => {
    if (stopped || child) return;
    if (remoteSock === null) {
      let home = "";
      if (!isAbsoluteRemote(opts.remoteSocketPath)) {
        try {
          probe = new AbortController();
          home = parseRemoteHome(
            await exec("ssh", ["-o", "BatchMode=yes", "--", opts.target, 'echo "$HOME"'], probe.signal),
          );
        } catch (e) {
          if (!stopped) {
            onError(`resolving remote herdr socket failed: ${String(e)}`);
            scheduleRestart();
          }
          return;
        } finally {
          probe = null;
        }
      }
      remoteSock = resolveRemoteSocket(opts.remoteSocketPath, home);
    }
    if (stopped) return;
    removeLocalSock();
    const startedAt = Date.now();
    const c = spawn("ssh", sshForwardArgs(opts.target, localSock, remoteSock));
    child = c;
    watchForUp();
    c.on("exit", () => {
      if (child === c) child = null;
      if (stopped) return;
      clearUpWatch();
      if (Date.now() - startedAt >= HEALTHY_AFTER_MS) backoff = RESTART_MIN_MS;
      onError("ssh tunnel exited; retrying");
      scheduleRestart();
    });
  };

  return {
    localSocket: localSock,
    start() {
      stopped = false;
      void connect();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      clearUpWatch();
      probe?.abort();
      probe = null;
      child?.kill();
      child = null;
      removeLocalSock();
    },
  };
}
