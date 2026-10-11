// src/herdr/client.ts
import { execFile } from "node:child_process";
import type { RawAgent } from "../core/agents";

export type RunFn = (cmd: string, args: string[], extraEnv?: Record<string, string>) => Promise<string>;

// Stream Deck launches the plugin with a minimal PATH; ensure Homebrew is reachable.
// Prepend (not append): prefers the known-good Homebrew binary and avoids a leading
// colon when PATH is empty, which would otherwise put CWD first and let a malicious
// `herdr` in the working directory run ahead of the real one.
const PATH_EXTRA = "/opt/homebrew/bin:/usr/local/bin";

// Shared promisified execFile (also used by the ssh tunnel): no shell, stderr
// folded into the rejection message.
export function execText(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs ?? 4000, maxBuffer: 1024 * 1024, env: opts.env, signal: opts.signal },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || err.message}`));
        else resolve(stdout);
      },
    );
  });
}

const defaultRun: RunFn = (cmd, args, extraEnv) =>
  execText(cmd, args, {
    env: { ...process.env, PATH: `${PATH_EXTRA}:${process.env.PATH ?? ""}`, ...extraEnv },
  });

export type NotifyOpts = { body?: string; sound?: "none" | "done" | "request" };

export type HerdrClient = {
  listAgents(): Promise<RawAgent[]>;
  focus(paneId: string): Promise<void>;
  notify(title: string, opts?: NotifyOpts): Promise<void>;
};

// `socketPath` (when it returns a path) targets the CLI at that herdr server
// socket via HERDR_SOCKET_PATH — this is how remote mode points the local
// `herdr` binary at the SSH-forwarded socket. A getter rather than a value so
// the client tracks settings changes without being rebuilt.
export function createHerdrClient(
  opts: { run?: RunFn; bin?: string; socketPath?: () => string | undefined } = {},
): HerdrClient {
  const baseRun = opts.run ?? defaultRun;
  const bin = opts.bin ?? "herdr";
  const run: (cmd: string, args: string[]) => Promise<string> = (cmd, args) => {
    const sock = opts.socketPath?.();
    return baseRun(cmd, args, sock !== undefined ? { HERDR_SOCKET_PATH: sock } : undefined);
  };
  return {
    async listAgents() {
      const out = await run(bin, ["agent", "list"]);
      const parsed: unknown = JSON.parse(out);
      const agents = (parsed as { result?: { agents?: unknown } })?.result?.agents;
      if (!Array.isArray(agents)) throw new Error("unexpected `herdr agent list` shape");
      return agents as RawAgent[];
    },
    async focus(paneId) {
      await run(bin, ["agent", "focus", paneId]);
    },
    async notify(title, opts = {}) {
      const args = ["notification", "show", title];
      if (opts.body !== undefined) args.push("--body", opts.body);
      if (opts.sound !== undefined) args.push("--sound", opts.sound);
      await run(bin, args);
    },
  };
}
