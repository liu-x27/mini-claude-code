# agent-app

A small, readable agent framework built on the Claude API — the agentic loop, a tool
registry, a permission system, and session persistence, with three ways to drive it:
a terminal REPL, a web UI, and a library API.

It is deliberately not a wrapper around someone else's agent SDK. The loop, the tool
protocol, and the permission model are all here in ~4,500 lines of TypeScript you can
read in an afternoon.

```
   CLI (REPL)  ─┐
   Web UI      ─┼─►  Agent  ─►  Claude API
   Library     ─┘      │
                       ├─ ToolRegistry   Bash · Read · Write · Edit · Glob · Grep · WebFetch
                       ├─ PermissionSystem   allow / ask / deny, per tool
                       └─ SessionManager     persisted transcripts, resumable
```

## Quickstart

```bash
npm install
cp .env.example .env    # add your ANTHROPIC_API_KEY
npm run cli
```

A real session, lightly trimmed:

```
agent-app · MiniMax-M2 · ask · D:\CODE\agent-app
Type a prompt, or /help for commands. Ctrl+C to quit.

› Which source files in this repo are over 300 lines? Use Bash with wc -l.
The user wants to find source files over 300 lines. Let me start by exploring
what files are in the repository.
⚙  Glob — {"pattern":"**/*.{ts,tsx,js,jsx,py,java,cpp,c,h}"}
   ok in 17ms
Now I'll use wc -l on all these files.
⚠  Permission required for Bash
   wc -l src/types.ts src/index.ts src/agent.ts server/index.ts examples/_debug-gre
   Allow? [y/N/a (always)/d (deny always)]: y

⚙  Bash — {"command":"wc -l src/types.ts src/index.ts src/agent.ts server/index.ts
   ok in 240ms
Here are the source files that are over 300 lines:

| File                     | Lines |
|--------------------------|-------|
| cli/index.ts             |   574 |
| client/src/App.tsx       |   551 |
| src/agent.ts             |   473 |
| server/index.ts          |   370 |
| examples/00-mock-test.ts |   305 |

[1920 tokens · in 1416 / out 504 · cache 2964 read · $0.02945]
```

One-shot mode, for scripts and pipes:

```bash
npm run cli -- -p "summarise the README" --read-only
```

The web UI is the same framework behind an Express server with SSE streaming:

```bash
npm run server     # :3001
npm run client     # :5173
```

Or use it as a library:

```ts
import { Agent } from "agent-app";

const agent = new Agent({
  model: "claude-opus-5",
  allowedTools: ["Read", "Glob", "Grep"],
});

const result = await agent.run("Explain what this codebase does");
console.log(result.text, result.usage.estimatedCostUsd);
```

## CLI

| Flag | |
|---|---|
| `-p, --print <prompt>` | run one prompt, print, exit |
| `-m, --model <id>` | default `claude-opus-5` |
| `-C, --cwd <path>` | working directory for file and shell tools |
| `--resume <id>` | continue a saved session |
| `--allow-all` / `--ask` / `--read-only` | permission preset (default `--ask`) |

In the REPL: `/help` `/tools` `/cost` `/sessions` `/resume <id>` `/new` `/model [id]`
`/permissions <preset>` `/cwd [path]` `/exit`.

## How it works

**The loop** (`src/agent.ts`) sends a prompt, executes any `tool_use` blocks Claude
returns, feeds the results back, and repeats until `end_turn` or `maxTurns`. Tool calls
in one response run concurrently, capped by `AGENT_MAX_CONCURRENT_TOOLS`. Streaming and
non-streaming share the same path; consumers subscribe with `agent.on(event => …)` and
get `text_delta`, `tool_start`, `tool_end`, `turn_start`, `turn_end`, `done`.

**Tools** (`src/tools/`) subclass `Tool<T>`, declaring a JSON Schema and a `summarize()`
used for permission prompts. `ToolRegistry` resolves the per-run set from `allowedTools`
and `disallowedTools`.

**Permissions** (`src/permissions/`) resolve each call to `allow`, `ask`, or `deny` by
most-specific-rule-wins, with presets for read-only and ask-before-dangerous. `ask` goes
through an injectable `PermissionPrompt`, so the caller decides how to reach the user —
the CLI reuses its own line reader, and a server can route the question anywhere.

**Sessions** (`src/session/`) are JSON transcripts under `~/.agent-app/sessions`, with
token and cost totals. Passing `resumeSessionId` replays one into the next run.

### Three things the REPL had to solve

A REPL is a harsher host than a one-shot script, and building it surfaced real problems
in the framework rather than in the terminal code. They are worth naming because the
fixes shaped the API:

1. **Who owns stdin.** Permission prompts used to open their own readline interface, so
   a REPL holding one would have two readers fighting over the same keystrokes. The fix
   was to make the prompt injectable rather than to work around it at the call site —
   which also means an HTTP server no longer blocks a request handler on the server
   process's stdin.

2. **Lines vanishing under a pipe.** `readline.question()` captures exactly one line and
   silently drops any that arrive while no question is pending. Invisible at a TTY,
   fatal when the CLI is driven from a pipe. `LineReader` queues every line instead, so
   interactive and scripted input behave identically.

3. **`run()` twice is two conversations.** `initSession()` only resumes when
   `resumeSessionId` is set, and the config is never updated after a run — so a naive
   REPL loop would lose all memory between turns while looking like it worked. The CLI
   seeds each turn with the previous turn's session id. An `Agent.continueSession()`
   would be the better fix; that is a core API change, still open.

## Development

```bash
npm test         # 22 assertions, mocked — no API key needed
npm run typecheck
npm run lint
npm run build
```

`npm run typecheck` covers `cli/`, `server/`, `client/` and `examples/` as well as
`src/`, which `npm run build` does not — the former are run through `tsx`, so nothing
else would catch their types.

Seven runnable examples live in `examples/`, from a single call to subagents and custom
tools.

### Any Anthropic-compatible endpoint

Nothing here is pinned to api.anthropic.com. The SDK honours `ANTHROPIC_BASE_URL`, so
a compatible provider works with no code change:

```bash
ANTHROPIC_BASE_URL=https://your-provider/anthropic \
ANTHROPIC_API_KEY=… \
npm run cli -- --model their-model-id
```

### Status

The tool layer, permission rules, session round-trips and cost maths are covered by the
mock suite and run on every change.

The live path — streaming, the agentic loop, tool calls, and the permission round-trip
under piped input — has been exercised end to end against an Anthropic-compatible
endpoint (MiniMax M2), but it is not in CI: it costs money and needs a key. Cost
figures come from the table in `src/utils/cost.ts`, which prices Anthropic models, so
they are meaningless against a third-party endpoint.

## Provenance

The core framework (agent loop, tools, permissions, sessions, web UI) was built in March
2026. The CLI, the injectable permission prompt, the repo-wide typecheck, and the move
to the current Claude model generation were added in September 2026, when the project
was cleaned up and published.
