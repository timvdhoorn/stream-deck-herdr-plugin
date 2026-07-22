// src/core/agents.ts
import type { AgentStatus } from "./status";

export type RawAgent = {
  agent?: string;
  agent_status?: string;
  cwd?: string;
  focused?: boolean;
  pane_id?: string;
  workspace_id?: string;
  tab_id?: string;
  terminal_title_stripped?: string;
};

export type Agent = {
  name: string;
  status: AgentStatus;
  cwd: string;
  paneId: string;
  workspaceId: string;
  focused: boolean;
  terminalTitle: string;
};

const KNOWN: ReadonlySet<string> = new Set(["idle", "working", "blocked", "done", "unknown"]);

function toAgent(r: RawAgent): Agent | null {
  if (!r || typeof r.pane_id !== "string") return null;
  const status: AgentStatus =
    typeof r.agent_status === "string" && KNOWN.has(r.agent_status)
      ? (r.agent_status as AgentStatus)
      : "unknown";
  return {
    name: typeof r.agent === "string" ? r.agent : "agent",
    status,
    cwd: typeof r.cwd === "string" ? r.cwd : "",
    paneId: r.pane_id,
    workspaceId: typeof r.workspace_id === "string" ? r.workspace_id : "",
    focused: r.focused === true,
    terminalTitle: typeof r.terminal_title_stripped === "string" ? r.terminal_title_stripped : "",
  };
}

export function normalize(raw: RawAgent[]): Agent[] {
  return raw
    .map(toAgent)
    .filter((a): a is Agent => a !== null)
    .slice()
    .sort(
      (a, b) =>
        a.workspaceId.localeCompare(b.workspaceId) || a.paneId.localeCompare(b.paneId),
    );
}

// Statuses worth a slot on the deck. Idle agents are intentionally hidden —
// they need no attention and would otherwise consume the limited keys.
export function visibleAgents(agents: Agent[]): Agent[] {
  return agents.filter((a) => a.status !== "idle");
}

// Display order for the deck: pinned agents first, in pin order (so the first
// pin lands on slot 1, the second next to it, …), kept visible even when idle;
// then the rest with idle agents hidden. `pinned` is a list of paneIds; stale
// pins (agent gone) are skipped.
export function orderForDisplay(all: Agent[], pinned: string[]): Agent[] {
  const pinnedSet = new Set(pinned);
  const pinnedAgents = pinned
    .map((id) => all.find((a) => a.paneId === id))
    .filter((a): a is Agent => a !== undefined);
  const rest = visibleAgents(all.filter((a) => !pinnedSet.has(a.paneId)));
  return [...pinnedAgents, ...rest];
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export type DisplayMode = "project" | "title";

export function labelFor(
  agent: Agent,
  peers: Agent[],
  display: DisplayMode = "project",
  max = 24,
): string {
  if (display === "title") {
    const title = agent.terminalTitle.trim();
    if (title) return truncate(title, max);
    // No title available — fall through to the project-name label.
  }
  const base = basename(agent.cwd) || agent.name;
  // Agents whose project name collides get a stable 1-based number (#1, #2, …),
  // ordered by paneId, so duplicates are told apart at a glance.
  const sameName = peers
    .filter((p) => (basename(p.cwd) || p.name) === base)
    .slice()
    .sort((a, b) => a.paneId.localeCompare(b.paneId));
  if (sameName.length <= 1) return truncate(base, max);
  const number = sameName.findIndex((p) => p.paneId === agent.paneId) + 1;
  const suffix = ` #${number}`;
  // Reserve room so the number always survives truncation.
  return `${truncate(base, Math.max(1, max - suffix.length))}${suffix}`;
}
