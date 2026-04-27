# pi-delegate

A tiny Pi package that adds exactly one tool: `delegate`.

`delegate` runs a fresh child Pi agent for an isolated task, then returns only the child’s concise final result and metadata. The point is context hygiene: let another agent inspect, research, or implement without dumping its scratchpad into the main conversation.

## Bun-first workflow

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`.
- Use `bun test` instead of Jest/Vitest.
- Use `bun run <script>` instead of npm/yarn/pnpm script runners.
- Use `bunx <package> <command>` instead of `npx`.
- Bun automatically loads `.env`; do not add dotenv.

## Validation

Run the same checks as CI before claiming the package is ready:

```bash
bun test
bun run typecheck
bun run check
bun pm pack --dry-run
PI_OFFLINE=1 bunx --bun pi --no-extensions -e . --list-models >/tmp/pi-delegate-pi-load.out
```
