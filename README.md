# pi-delegate

[![npm version](https://img.shields.io/npm/v/pi-delegate.svg)](https://www.npmjs.com/package/pi-delegate)
[![CI](https://github.com/drsh4dow/pi-delegate/actions/workflows/ci.yml/badge.svg)](https://github.com/drsh4dow/pi-delegate/actions/workflows/ci.yml)

One Pi tool: `delegate`.

Give Pi a clean side thread. `delegate` starts a fresh child agent, gives it a task, then brings back only the useful result. No child transcript. No scratchpad spill. No context mud.

Small by design: no workflow engine, background job manager, dashboard, or artifact system. One tool. One job. Keep the main context clean.

## Install

```bash
pi install npm:pi-delegate
```

## What it adds

`pi-delegate` adds the `delegate` tool.

The tool runs a fresh in-memory child Pi agent in the current project, waits for the task to finish, and returns:

- the child’s concise final report
- model/effort metadata
- duration
- tool/error counts
- structured timeout/failure state when needed

The main agent never sees the child’s intermediate exploration.

## Tool API

### `delegate`

Parameters:

- `task`: the task for the child agent
- `effort`: optional `fast | balanced | smart` — default `balanced`

Effort maps to one model with different thinking levels:

| effort | model | thinking |
| --- | --- | --- |
| `fast` | `openai-codex/gpt-5.5` | `minimal` |
| `balanced` | `openai-codex/gpt-5.5` | `medium` |
| `smart` | `openai-codex/gpt-5.5` | `high` |

If `openai-codex/gpt-5.5` is missing or unauthenticated, `delegate` falls back to the parent model and reports the fallback in metadata.

## Behavior

- fresh in-memory child session
- parent cwd
- project context files loaded
- available Pi extensions loaded, so tools like web search can work
- recursive delegation tools are disabled inside the child
- sequential execution to avoid concurrent delegated writes
- 15-minute internal timeout
- structured failure results instead of thrown tool errors
- normal Pi tools are available to the child, including write-capable tools; delegate edits only when edits are intended

## When to use it

Use `delegate` for work that benefits from isolation:

- scan a code area without filling the main context
- research a library/API and report the answer
- ask a child agent to review a plan
- implement a narrow change while the main agent keeps orchestration context clean

Do not use it as a workflow engine. If you need chains, background jobs, worktrees, or agent management, use a purpose-built workflow package.

## Development

```bash
bun install
bun test
bun run typecheck
bun run check
bun pm pack --dry-run
PI_OFFLINE=1 bunx --bun pi --no-extensions -e . --list-models >/tmp/pi-delegate-pi-load.out
```
