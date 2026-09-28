# pi-ultracode

Claude Code's **ultracode** / **dynamic workflows** for [pi](https://pi.dev).

The model writes a short JavaScript script that orchestrates many subagents. The script runs in the background, holds the loops, branching and intermediate results itself, and only its final return value comes back into your conversation. Use it for codebase-wide audits, many-file migrations, research that needs cross-checking, or drafting a hard plan from several independent angles.

Run `/ultracode` to enable automatic workflows, then ask for an audit. Without the command, ultracode stays off: typing “ultracode” in an ordinary message does not enable it. You can still request a workflow explicitly or use the `workflow` tool while off. Ultra and ultracode are mutually exclusive: run `/ultra` to turn Ultra off before activating `/ultracode`.

## Install

```bash
pi install git:github.com/rebehzat/pi-ultracode
```

## What you get

| | |
|---|---|
| `/ultracode [on\|off\|status]` | Off by default. Bare `/ultracode` toggles; `on` enables `xhigh` thinking and automatic workflows for substantive tasks, `off` restores your previous thinking level, and `status` reports the mode. Only this command enables the mode. An animated `⚡ultracode` badge appears on the editor border while on. |
| `workflow` tool | What the model calls. Takes `script` (or `script_path`, or `name` of a saved workflow), optional `args`, and `resume` (a run id). |
| Live widget | Spinner, phase, agent counts, elapsed time, tokens and cost for each running workflow, above the editor. |
| `/workflows` | Browse runs → phases/agents (prompt, tool calls, result), log, pause/resume, stop, stop/restart one agent, view script/result, **save as a command**, **delete** finished or interrupted runs. Saved workflows are listed at the bottom (view/delete). |
| `workflow_manage` tool | Lets the agent `list` runs and saved workflows, get a run's `status`, `pause`/`resume`/`stop` runs executing in this pi, `dismiss` interrupted runs, and `delete` runs or saved workflows. Deletes happen immediately, without a confirmation prompt. |
| Saved workflows | Saved to `.pi/workflows/` (project, nearest dir wins) or `~/.pi/agent/workflows/` (personal), and run as `/<name> [args]`. JSON args go straight to the script; free-form text is passed to the model to turn into structured args. |

## Script API

```js
export const meta = { name: 'audit-routes', description: 'Audit routes for missing auth', phases: ['Discover', 'Audit'] }

phase('Discover')
const found = await agent('List every .ts file under src/routes/.', {
  schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },
})

phase('Audit')
const audits = await pipeline(found.files, file => agent(`Audit ${file} for missing authentication checks.`, { label: file }))
return audits.filter(Boolean)
```

- `agent(prompt, { label, schema, model, thinking, tools, cwd, systemPrompt })`: one fresh `pi` subprocess (JSON mode) with its own context. It resolves to the final text, or to schema-validated JSON (invalid output is sent back to the same session for a fix, up to 3 tries by default). It resolves to `null` when the agent is stopped or fails.
- `parallel([...promises|fns])`, `pipeline(items, fn)`: fan out, wait for all. Rejections become `null`.
- `phase(title)`, `log(...)`, the `args` global, and top-level `return`.
- `Date.now()`, `new Date()` and `Math.random()` throw, and `import`/`require` are rejected, so a relaunch replays the same calls.

## How it runs

- Each run gets its own directory, `~/.pi/agent/ultracode/runs/<id>/`, holding `script.js`, `args.json`, `journal.jsonl`, `result.json`, and child Pi sessions under `agents/<index>/`. Fresh retries and restarts use separate `attempt-*` session directories so prior charges remain available.
- **Resume:** `workflow { resume: "<id>" }` starts a new run in which any agent whose prompt and options match a finished agent in the old run returns its saved result.
- **Cost/usage:** the widget, status, and result sum persisted billable Pi session entries for every workflow child (including interrupted runs, failed attempts, abandoned branches, and the original sessions of resumed runs). Cached journal replays and JSON stream events are not added again; live totals refresh as sessions are written. Assistant, tool-result, explicit usage, compaction, and branch-summary usage are included; reasoning tokens are already part of output. These workflow totals are separate from the parent Pi session's total. Older runs whose failed attempt directories were deleted before this version cannot recover those missing charges; deleting an original run's files likewise removes its historical usage from a resumed run's reported total.
- **Interrupted runs:** a run lives in the pi process that started it. If that process exits (you quit pi, close the terminal, or it's killed), the run stops. `run.json` in the run directory records its owner process and session, so when you resume that session the run shows as **⚠ interrupted** in the widget and in `/workflows`, with a one-key **Resume** that reuses every finished agent. The agent is told about such runs too, so it won't assume they are still running. A run owned by another live pi process shows as running there.
- **Concurrency:** `min(16, CPUs)` by default; override with `PI_WORKFLOW_MAX_CONCURRENT_AGENTS` (1–256). A run can start at most 1000 agents, and one `parallel()`/`pipeline()` call takes at most 4096 items.
- **Where it runs:** in the TUI and RPC modes, runs happen in the background and the result arrives as a follow-up message that starts a new turn. In `pi -p` / JSON mode, the tool waits for the run to finish.
- **Agents:** they use your session's model, but routine worker thinking is capped at `medium` by default (lower session levels are preserved). The orchestrator still uses `xhigh` in ultracode mode. Set `agentThinking: "inherit"` to restore the previous behavior, or request `thinking: "high"` / `"xhigh"` on difficult individual tasks. An explicit per-agent model without thinking uses that model's Pi defaults, as before. Workers load your other extensions, but delegation tools (`spawn_agent`, `wait_agent`, related agent-management tools, and workflow tools) are excluded: the workflow script owns all fan-out and its concurrency cap. An explicit `tools: []` disables all tools.
- **Sandboxing:** the script runs in a `node:vm` context. That keeps scripts deterministic but is **not** a security sandbox. Agents run with your normal pi tools and permissions.

## Config

Optional `~/.pi/agent/ultracode.json`:

```json
{
  "sizeGuideline": "medium",
  "rainbowEditor": true,
  "maxConcurrentAgents": 16,
  "maxStructuredRetries": 3,
  "agentModel": "anthropic/claude-sonnet-5",
  "agentThinking": "medium"
}
```

`sizeGuideline` is advice to the model while mode is on, not a cap: `small` (<5 agents), `medium` (<10), `large` (<50), `unrestricted`. `rainbowEditor` swaps in pi's editor component for the on-mode badge; turn it off if another extension provides its own editor. Neither config nor a CLI flag enables ultracode.

## Performance

- Independent tasks should use `parallel()` / `pipeline()`, not an `await` loop. Batch tiny tasks, supply already-known paths/context, and verify concrete changes rather than adding repeated discovery/planning/review workflows.
- Worker delegation is disabled to avoid nested spawn/wait chains that bypass workflow concurrency. Keep orchestration in the script.
- Child usage accounting caches billable records and reads appended JSONL data instead of reparsing entire histories. Progress refreshes usage at most once per second; final totals are refreshed on completion. Fork/resume deduplication and failed-attempt billing are preserved.
- Run discovery reads small metadata first; child sessions, journal counts, and legacy results are loaded only when needed. Old unrelated runs no longer make every prompt rescan their full transcripts.
- The scheduler wakes only agents that can start, and queued agents can be cancelled while paused. Pi's exhausted automatic retries and permanent auth/model errors no longer trigger a redundant fresh-process retry. Other process failures retain one retry.
- Child JSON streams use UTF-8-safe, linear framing and skip irrelevant events before parsing. API retry waits appear in agent activity.
- `maxStructuredRetries` (total schema attempts) defaults to 3 and is capped at 10; `MAX_STRUCTURED_OUTPUT_RETRIES` overrides it. Concurrency/retry settings reject non-finite and non-positive values.

`npm test` includes regression coverage and an isolated usage-scan benchmark. These changes reduce local overhead and redundant work, not provider latency; large builds or difficult reasoning can still take time. Let active workflows finish, then run `/reload` to load extension changes; existing runs are not retroactively optimized.

## Differences from Claude Code

- There is no git-worktree isolation for agents yet. Parallel agents share the working tree, and the model is told to give each agent a disjoint set of files.
- Resume matches finished agents by prompt and options; it does not rerun everything after the first changed agent.
- `/workflows` is built from pi's select and editor dialogs, not a dedicated full-screen view.
- There is no bundled `/deep-research`. Save your own workflow instead.

## Development

```bash
npm install
npm run typecheck
npm test          # runtime, subprocess, accounting and performance tests (Pi's TS loader)
pi -e ./extensions/ultracode/index.ts
```

## License

MIT
