import net from "node:net";
import os from "node:os";
import path from "node:path";

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export function herdrSocketPath(): string {
  return process.env.HERDR_SOCKET_PATH ?? path.join(os.homedir(), ".config", "herdr", "herdr.sock");
}

// Pure: split an accumulated buffer + new chunk into complete lines and the
// remaining partial line. Keeps multi-chunk JSON lines intact.
export function feedLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (buffer + chunk).split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.trim().length > 0), rest };
}

// `pane.updated` fires on any pane state change (agent_status included) and
// needs no pane_id. Since herdr 0.8, `pane.agent_status_changed` requires a
// concrete pane_id, which rejects the whole subscribe request — and the server
// honors only one subscribe per connection, so the set must be valid as a whole.
const SUBSCRIBE =
  JSON.stringify({
    id: "sd-sub",
    method: "events.subscribe",
    params: {
      subscriptions: [
        { type: "pane.updated" },
        { type: "pane.created" },
        { type: "pane.closed" },
        { type: "pane.exited" },
        { type: "pane.agent_detected" },
      ],
    },
  }) + "\n";

// Decide which socket lines warrant a refresh. pane_updated fires on every
// pane state change (scroll, terminal titles, output), so refreshing per line
// would spawn `herdr agent list` continuously while an agent streams output.
// Only the fields the deck renders from (agent, status, cwd) count; anything
// unrecognized errs on the side of refreshing. Stateful per connection: keeps
// one fingerprint per pane.
export function createRelevanceFilter(): (line: string) => boolean {
  const seen = new Map<string, string>();
  return (line) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return true;
    }
    const { event, data } = (msg ?? {}) as {
      event?: unknown;
      data?: { pane_id?: unknown; pane?: { pane_id?: unknown; agent?: unknown; agent_status?: unknown; cwd?: unknown } };
    };
    if (typeof event !== "string") return true; // subscribe acks, errors, unknown shapes
    if (event === "pane_closed" || event === "pane_exited") {
      const id = data?.pane_id ?? data?.pane?.pane_id;
      if (typeof id === "string") seen.delete(id);
      return true;
    }
    if (event !== "pane_updated") return true;
    const pane = data?.pane;
    const id = pane?.pane_id;
    if (typeof id !== "string") return true;
    const fingerprint = `${String(pane?.agent ?? "")}|${String(pane?.agent_status ?? "")}|${String(pane?.cwd ?? "")}`;
    if (seen.get(id) === fingerprint) return false;
    seen.set(id, fingerprint);
    return true;
  };
}

export type EventsClient = { start(): void; stop(): void };

// Calls onChange() whenever herdr emits a subscribed event line (and once on the
// subscribe ack). Auto-reconnects with exponential backoff. Never throws.
// Restartable: each start() opens a new epoch, so callbacks and reconnect
// timers from an earlier lifecycle (a destroyed socket's delayed close, a
// pending backoff timer) can never open a second connection alongside the
// current one.
export function createHerdrEvents(opts: { onChange: () => void; socketPath?: string }): EventsClient {
  const sockPath = opts.socketPath ?? herdrSocketPath();
  let stopped = false;
  let conn: net.Socket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let epoch = 0;
  let backoff = RECONNECT_MIN_MS;

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleReconnect = (myEpoch: number): void => {
    if (stopped || myEpoch !== epoch) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      connect(myEpoch);
    }, wait);
  };

  const connect = (myEpoch: number): void => {
    if (stopped || myEpoch !== epoch) return;
    let c: net.Socket;
    try {
      c = net.createConnection(sockPath);
    } catch {
      // Some runtimes (Bun) raise connect errors synchronously, before the
      // error listener below exists. Treat it like any failed attempt.
      scheduleReconnect(myEpoch);
      return;
    }
    conn = c;
    let buffer = "";
    const relevant = createRelevanceFilter();
    c.on("connect", () => {
      backoff = RECONNECT_MIN_MS;
      c.write(SUBSCRIBE);
    });
    c.on("data", (chunk: Buffer) => {
      const fed = feedLines(buffer, chunk.toString("utf8"));
      buffer = fed.rest;
      // filter (not some): every line must reach the filter so it fingerprints
      // all panes in the chunk, not just up to the first relevant one.
      if (fed.lines.filter(relevant).length > 0) opts.onChange();
    });
    const reconnect = (): void => {
      if (stopped || myEpoch !== epoch) return;
      c.removeAllListeners();
      if (conn === c) conn = null;
      scheduleReconnect(myEpoch);
    };
    c.on("error", reconnect);
    c.on("close", reconnect);
  };

  return {
    start: () => {
      stopped = false;
      epoch += 1;
      backoff = RECONNECT_MIN_MS;
      clearTimer();
      conn?.destroy(); // defensive: a start without stop must not leak the old socket
      conn = null;
      connect(epoch);
    },
    stop: () => {
      stopped = true;
      epoch += 1;
      clearTimer();
      conn?.destroy();
      conn = null;
    },
  };
}
