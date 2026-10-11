// src/plugin.ts
import streamDeck from "@elgato/streamdeck";
import { createHerdrClient } from "./herdr/client";
import { createTerminalActivator } from "./os/terminal";
import { createAgentStore } from "./core/store";
import { AgentSlotAction } from "./actions/slot";
import { PagerAction } from "./actions/pager";
import { createHerdrEvents, type EventsClient } from "./herdr/events";
import { createSshTunnel, type Tunnel } from "./herdr/tunnel";
import { detectFlips } from "./core/transitions";
import { labelFor } from "./core/agents";
import type { Agent } from "./core/agents";

// Plugin-wide connection settings (set from any Agent Slot property inspector).
// Empty sshTarget = talk to the herdr server on this machine (the default).
type GlobalSettings = { sshTarget?: string; remoteSocketPath?: string };

streamDeck.logger.setLevel("info");

let tunnel: Tunnel | null = null;

// In remote mode every herdr CLI call targets the SSH-forwarded socket.
const herdr = createHerdrClient({ socketPath: () => tunnel?.localSocket });
// undefined app → default (iTerm); set HERDR_DECK_TERMINAL_APP to override.
const terminal = createTerminalActivator({ app: process.env.HERDR_DECK_TERMINAL_APP });
const store = createAgentStore({ fetchAgents: () => herdr.listAgents() });

const slot = new AgentSlotAction(store, herdr, terminal);
const pager = new PagerAction(store, herdr, terminal);

let prevAgents: Agent[] | null = null;

store.subscribe((s) => {
  slot.renderAll();
  pager.renderAll();

  // Unhealthy snapshots (startup, connection down) must not become the
  // notification baseline: a wiped list diffed against the first real snapshot
  // would alert for every agent that was already blocked/done. Keep the
  // baseline suppressed until the connection actually delivers.
  if (!s.healthy) { prevAgents = null; return; }
  if (prevAgents === null) { prevAgents = s.agents; return; } // prime, no alert on first snapshot
  const flips = detectFlips(prevAgents, s.agents);
  prevAgents = s.agents;
  for (const a of flips) {
    const sound = a.status === "blocked" ? "request" : "done";
    void herdr.notify(`${labelFor(a, s.agents)} ${a.status}`, { body: a.name, sound });
    slot.flash(a.paneId);
  }
});

// Debounce refreshes so a burst of socket events causes at most one poll.
let pending: ReturnType<typeof setTimeout> | null = null;
const refresh = (): void => {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    void store.pollNow();
  }, 150);
};

let events: EventsClient | null = null;
let appliedKey: string | null = null;

// Tear down and rebuild the herdr connection (tunnel + event subscription) for
// the given settings. Local mode: events on the default local socket. Remote
// mode: an ssh unix-socket forward, with both the CLI and the event
// subscription pointed at the forwarded socket; the event client (re)starts on
// the tunnel's onUp signal so it connects the moment the forward binds instead
// of sitting out its own reconnect backoff.
const applyConnection = (gs: GlobalSettings): void => {
  const target = gs.sshTarget?.trim() ?? "";
  const remoteSock = gs.remoteSocketPath?.trim() ?? "";
  const key = `${target}\n${remoteSock}`;
  if (key === appliedKey) return;
  appliedKey = key;

  events?.stop();
  events = null;
  tunnel?.stop();
  tunnel = null;
  // The next snapshot comes from a different server (or a rebuilt connection):
  // prime on it instead of diffing across servers, which would fire a
  // notification for every already-blocked/done agent over there. Resetting the
  // store (not just the baseline) keeps an in-flight fetch or a pin/page
  // re-render from priming the baseline with the old server's list.
  store.reset();

  if (target === "") {
    streamDeck.logger.info("herdr connection: local");
    const ev = createHerdrEvents({ onChange: refresh });
    events = ev;
    ev.start();
  } else {
    streamDeck.logger.info(`herdr connection: remote via ssh ${target}`);
    const t = createSshTunnel({
      target,
      remoteSocketPath: remoteSock === "" ? undefined : remoteSock,
      onUp: () => {
        ev.stop();
        ev.start();
        refresh();
      },
      onError: (m) => streamDeck.logger.error(`tunnel: ${m}`),
    });
    const ev = createHerdrEvents({ onChange: refresh, socketPath: t.localSocket });
    tunnel = t;
    events = ev;
    t.start();
  }
  refresh();
};

// Stream Deck stops the plugin by terminating the process; without this the
// ssh forward child would outlive us and its socket file would leak in tmpdir.
process.on("exit", () => tunnel?.stop());
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => process.exit(0)); // run the exit handler
}

streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => applyConnection(ev.settings));

streamDeck.actions.registerAction(slot);
streamDeck.actions.registerAction(pager);

await streamDeck.connect();
applyConnection(await streamDeck.settings.getGlobalSettings<GlobalSettings>());
store.start(3000); // safety net; socket events drive the fast path
