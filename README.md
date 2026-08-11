# Mona Agent

A lightweight, OpenClaw-style device agent with a **cloud brain**.

- 🔑 Requires an **agent.mona.expert** API key — nothing else.
- 🚫 **No LLM provider keys stored locally.** All reasoning, thinking, and planning happen online at `agent.mona.expert`.
- 📡 Streams **device monitoring, agent steps, and tokens** live to `agent.mona.expert`.
- 🖥️ Clean local **GUI dashboard**.
- ⚡ One-line install.

## Install

```bash
curl -fsSL https://agent.mona.expert/install.sh | bash
```

Then:

```bash
mona-agent login          # paste your agent.mona.expert API key
mona-agent run "check disk usage and summarize"
```

Launch the GUI:

```bash
npm run gui               # → http://localhost:4319
```

## How it works

```
 ┌────────────┐    prompts + steps     ┌───────────────────────┐
 │  Your      │ ─────────────────────▶ │  agent.mona.expert     │
 │  device    │   streamed reasoning   │  (LLM brain, keys,     │
 │  (this app)│ ◀───────────────────── │   policy, memory)      │
 └────────────┘                        └───────────────────────┘
        │  device metrics + agent steps (WebSocket)  ▲
        └────────────────────────────────────────────┘
```

- **`src/config.js`** — stores only your `agent.mona.expert` API key (`~/.mona-agent/credentials.json`, chmod 600).
- **`src/cloud.js`** — sends messages to the cloud brain and streams reasoning back.
- **`src/telemetry.js`** — WebSocket stream of device metrics + agent steps to the domain.
- **`src/agent.js`** — the local run loop (remote reasoning, local execution + telemetry).
- **`src/gui/`** — the dashboard.

## Commands

| Command | Description |
|---|---|
| `mona-agent login` | Save your API key |
| `mona-agent status` | Show login state |
| `mona-agent run "<task>"` | Run a task (reasoning in the cloud) |
| `npm run gui` | Start the GUI at `http://localhost:4319` |

## Privacy

The only secret on your device is the `agent.mona.expert` API key. Model provider keys, prompts policy, and long-term memory live server-side.

## License

MIT
