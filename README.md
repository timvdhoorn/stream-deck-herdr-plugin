# herdr agents — Stream Deck plugin

Live [herdr](https://herdr.dev) agent status on your Elgato Stream Deck.

See which of your AI coding agents are running, busy, blocked, or finished — at a
glance, on physical keys. Press a key to jump straight to that agent's pane and
bring your terminal to the foreground. No more hunting through tabs to find the
agent that's waiting on you.

![herdr agents running on a Stream Deck Mini](docs/deck.png)

## What it does

- **One key per agent.** Each key mirrors a live herdr agent: project label +
  status color + a monochrome logo of the agent type (Claude, Codex, …).
- **Status at a glance** — color and glyph encode `working` / `blocked` / `done`
  / `idle` (see the table below).
- **Press = focus.** A short press runs `herdr agent focus` for that pane *and*
  raises the host terminal app, so the agent is actually on screen even if the
  terminal was in the background.
- **Long-press = pin.** Holding a key pins the agent — it jumps to the front,
  stays visible even when it goes idle, and gets a pushpin badge. Pins are
  in-memory (reset when the plugin restarts).
- **Morphing pager key.** When any agent needs attention it becomes a
  "jump to the next blocked/done agent" key (cycles on repeat presses);
  otherwise it pages through the agent grid. One key, both jobs — fits the 6-key
  Mini.
- **Active notifications.** When an agent flips to `blocked` or `done` you get a
  herdr notification with a sound (`request` / `done`) and the key flashes — even
  when you're not looking at the deck.
- **Idle agents are hidden** so the deck only shows agents that matter.
- **Instant updates.** Refreshes on herdr socket events (push), with a slow
  safety-net poll as a backstop — no busy 1-second polling.

## Status → key

| status   | color      | glyph | meaning           |
|----------|------------|-------|-------------------|
| working  | orange     | ●     | running now        |
| blocked  | red        | ▲     | wants you          |
| done      | green      | ✓     | finished, unseen   |
| idle     | grey       | ○     | waiting (hidden)   |
| unknown  | near-black | ·     | —                  |
| empty    | black      |       | no agent in slot   |

## Tested on

- **Stream Deck Mini** (6 keys)
- macOS 26 (Apple Silicon)
- Elgato Stream Deck app **7.4.2**
- **herdr 0.8.0**

The plugin is keypad-only and works on any Stream Deck model with keys. The
default layout assumes the 6-key Mini, but you can place the two actions on a
deck of any size.

## Requirements

- macOS 12 or newer
- [Elgato Stream Deck](https://www.elgato.com/stream-deck) app 7.1+
- [herdr](https://herdr.dev) 0.8.0+ installed and running (`herdr` on your `PATH`)
- To build from source: [Bun](https://bun.sh) and Node.js 24

## Install

### From source

```bash
git clone https://github.com/timvdhoorn/stream-deck-herdr-plugin.git
cd stream-deck-herdr-plugin
bun install
bun run build

# enable Stream Deck developer mode (one-time), then link + start the plugin
bunx streamdeck dev
bunx streamdeck link dev.timvdhoorn.herdr-agents.sdPlugin
bunx streamdeck restart dev.timvdhoorn.herdr-agents
```

### As a packaged plugin

Produce a double-clickable `.streamDeckPlugin` installer:

```bash
bun run build
bunx streamdeck pack dev.timvdhoorn.herdr-agents.sdPlugin
```

This writes `dev.timvdhoorn.herdr-agents.streamDeckPlugin` — double-click it to
install into the Stream Deck app.

## Layout & usage

In the Stream Deck app, drag the two actions from the **herdr** category onto
your keys. The recommended 6-key Mini layout:

```
[ Agent Slot 0 ][ Agent Slot 1 ][ Agent Slot 2 ]
[ Agent Slot 3 ][ Agent Slot 4 ][    Pager      ]
```

- **Agent Slot** — set its `slotIndex` (0–4) in the Property Inspector. Each slot
  shows one agent.
  - *Short press* → focus that agent's pane + raise the terminal.
  - *Long press* → pin/unpin the agent.
- **Pager** — jumps to the next agent needing attention, or pages the grid when
  none do.

Prefer a flat, no-paging layout? Place six **Agent Slot** keys (`slotIndex` 0–5)
and skip the pager.

## Remote herdr over SSH

By default the plugin talks to the herdr server on the machine the Stream Deck
is attached to. If your agents run on another box (and you attach to them with
`herdr --remote <host>`), point the plugin at that box instead. Setup is three
steps; step 1 is one-time SSH plumbing.

### 1. One-time: key-based SSH to the agent box

The plugin runs `ssh` in the background with `BatchMode=yes` — it can never
prompt for a password, so password-only SSH will not work. From the Stream
Deck machine:

```bash
# create a key if you don't have one (Enter twice = no passphrase)
ssh-keygen -t ed25519

# install it on the agent box (enter your password one last time)
ssh-copy-id me@agentbox

# verify — this is exactly what the plugin does, and it must print "ok"
# with no password or host-key prompt:
ssh -o BatchMode=yes me@agentbox 'echo ok'
```

If that last command prints `ok`, the plugin will connect. Optional but
recommended: give the box an alias in `~/.ssh/config` and use the alias
everywhere (the plugin setting, `herdr --remote`, plain `ssh`):

```
Host agentbox
    HostName 192.168.1.50
    User me
```

You also need herdr installed on the Stream Deck machine: the CLI runs
locally and talks to the remote server's socket, so keep the two herdr
versions compatible.

### 2. Point the plugin at the box

1. Open any **Agent Slot** key's Property Inspector.
2. Set **SSH remote** to the target from step 1 (`me@agentbox`, or the
   `agentbox` alias). These settings are global — set once, applies to every
   key.
3. Leave **Remote socket** empty unless the remote herdr uses a non-default
   socket path (`~/.config/herdr/herdr.sock`).

### 3. Verify

Keys should populate with the remote agents within a few seconds, and status
changes should track live. Press a key: the pane switches inside your
`herdr --remote` attach and your local terminal comes to the front.

Clear **SSH remote** to go back to local mode; changes apply immediately, no
restart needed.

### Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Step 1's verify asks for a password | The key isn't installed — rerun `ssh-copy-id`. |
| Verify asks "authenticity of host …?" | Host key not yet trusted: answer `yes` once by hand; the plugin never gets this prompt. |
| Verify works only after a passphrase prompt | Passphrase-protected key. Either strip it (`ssh-keygen -p`, empty new passphrase) or load it into the agent (`ssh-add --apple-use-keychain` + `UseKeychain yes` in `~/.ssh/config`). |
| Verify prints extra text before `ok` | Harmless — the plugin tolerates shell-rc noise. |
| Keys stay blank in remote mode | Check the plugin log (`~/Library/Logs/ElgatoStreamDeck/`, plugin has debug enabled) for `herdr connection:` and `tunnel:` lines — they name the failing step. |
| Keys go blank when an agent finishes | Not a bug: idle agents are hidden by design. Long-press to pin one. |

### How it works

The plugin keeps a single `ssh -N -L local.sock:remote.sock` Unix-socket
forward alive (auto-reconnect with backoff) and points both the local `herdr`
CLI (via `HERDR_SOCKET_PATH`) and its event subscription at the forwarded
socket. Focusing an agent switches the pane on the server, which your
`herdr --remote` attach mirrors, and the terminal raise still happens locally —
so "press = focus" works exactly as in the local setup. ssh is spawned without
a shell and the target is passed after `--`, so the settings text can't inject
options.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `HERDR_DECK_TERMINAL_APP` | `iTerm` | AppleScript name of the terminal app that hosts herdr. Set it to e.g. `Terminal`, `Ghostty`, or `WezTerm` so "press = focus" brings the right app to the front. |

## How it works

A single store polls/streams `herdr agent list`, normalizes the agents, and
notifies both actions to re-render. All herdr I/O is isolated in
`src/herdr/*` (injected `run` for tests), the pure logic lives in `src/core/*`
(unit-tested with `bun test`), and the Stream Deck actions in `src/actions/*` are
thin glue. Key images are rendered as SVG data URIs for crisp text on the 80×80
keys.

## Development

```bash
bun test                    # run the unit tests
bunx tsc --noEmit           # type-check
bun run build               # bundle to …/bin/plugin.js
bun run watch               # rebuild + restart the plugin on change
```

## License

[MIT](LICENSE) © Tim van der Hoorn
