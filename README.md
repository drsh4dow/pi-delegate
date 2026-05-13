# pi-delegate

[![npm version](https://img.shields.io/npm/v/pi-delegate.svg)](https://www.npmjs.com/package/pi-delegate)

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
- child tool/error counts
- child turn/token/cost usage when the provider reports usage
- output truncation metadata when the final report is large
- native tool errors with concise failure metadata when delegation fails

The main agent never sees the child’s intermediate exploration.

## Tool API

### `delegate`

Parameters:

- `task`: the task for the child agent
- `effort`: optional `fast | balanced | smart` — default `balanced`, but callers should choose explicitly

Effort maps to one model with different thinking levels:

| effort | model | thinking |
| --- | --- | --- |
| `fast` | `openai-codex/gpt-5.5` | `minimal` |
| `balanced` | `openai-codex/gpt-5.5` | `medium` |
| `smart` | `openai-codex/gpt-5.5` | `high` |

Choose `fast` for scouting, repo mapping, docs/API lookup, and quick read-only recon. Choose `smart` for review, critique, debugging, ambiguous design, and high-risk reasoning. Use `balanced` for moderate investigation or exceptional, explicitly write-capable child implementation.

If `openai-codex/gpt-5.5` is missing or unauthenticated, `delegate` falls back to the parent model and reports the fallback in metadata.

## Behavior

- fresh in-memory child session
- parent cwd
- project context files loaded through Pi's normal resource discovery
- extensions and package resources discovered from the child session's cwd/agent directory are loaded; ad-hoc extension paths listed in `PI_CHILD_EXTENSION_PATHS` are also loaded in the child
- recursive delegation tools are disabled inside the child
- sequential execution to avoid concurrent delegated writes
- 15-minute internal timeout
- running calls render as neutral progress, not failure; the tool header stays compact, while the result area shows the assigned task in a boxed card
- collapsed task cards show the first four non-empty task lines with a hidden-line hint; expanded tool output shows the full assigned task
- completed calls include a bounded child-report preview when collapsed and the full child report when expanded
- parent-facing delegation policy is tool-owned through the active `delegate` tool description, snippet, guidelines, and parameter descriptions; the package does not append a separate parent system prompt
- child final reports are prompted as handoff-ready summaries with task, result, evidence, files, verification, and only-important handoff notes
- failures throw native Pi tool errors with a concise reason plus model/duration/tool-count metadata
- final child output is truncated at Pi's standard 2000-line/50KB tool-output limits, with the full report saved to a temp file when truncation occurs
- normal Pi tools are available to the child, including write-capable tools; parent agents should keep implementation/final validation in the parent by default and delegate write-capable child tasks only when explicit or exceptional

## Package shape

The npm package is both a Pi package and a small TypeScript module. Pi loads `./extensions/delegate.ts` from the package manifest, while `./index.ts` re-exports the extension and helper types for tests or advanced consumers.

## When to use it

Use `delegate` for work that benefits from isolation:

- scan a code area without filling the main context
- research a library/API and report the answer
- get an explicitly requested independent/fresh review
- investigate noisy failures and report evidence

Do not use it as a workflow engine or a default implementation worker. The parent agent owns implementation, final validation, and the final answer unless the user explicitly asks for child implementation or the task has a clear exceptional isolation benefit. Explicit independent/fresh review requests should use delegation because isolation is the product. If you need chains, background jobs, worktrees, or agent management, use a purpose-built workflow package.

## Development

```bash
bun install
bun test
bun run typecheck
bun run check
bun pm pack --dry-run
PI_OFFLINE=1 bunx --bun pi --no-extensions -e . --list-models >/tmp/pi-delegate-pi-load.out
```

## Live delegate evals

`live-eval.test.ts` runs Pi in JSON mode against disposable fixture repos and compares delegate-enabled runs with a delegate-disabled control. It is opt-in locally because it uses live model calls:

```bash
PI_DELEGATE_LIVE=1 \
PI_DELEGATE_EVAL_JUDGE_MODEL=openai/gpt-5.5:low \
PI_DELEGATE_EVAL_TIMEOUT_MS=1800000 \
PI_DELEGATE_EVAL_MAX_TOKENS=1500000 \
PI_DELEGATE_EVAL_MAX_COST_USD=30 \
PI_DELEGATE_EVAL_ARTIFACT_DIR=artifacts/live-eval \
bun run test:live
```

`PI_DELEGATE_EVAL_MODEL` and `PI_DELEGATE_EVAL_JUDGE_MODEL` default to `openai/gpt-5.5:low`. Use `PI_DELEGATE_EVAL_TASKS=id1,id2` to run a subset while tuning the policy.

The suite records sanitized JSONL traces plus `summary.json`, including delegate decision and effort-selection KPIs. It hard-fails crashes, budget overruns, read-only writes, required/forbidden delegate decision misses, and effort mismatches when delegate is called with an expected effort; implementation fixtures are generally allowed-not-required delegation. Judge quality scores remain calibration data.
