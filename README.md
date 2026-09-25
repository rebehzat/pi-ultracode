# pi-ultracode

Claude Code's **ultracode** / **dynamic workflows** for [pi](https://pi.dev).

The model writes a short JavaScript script that orchestrates many subagents. The script runs in the background, holds the loops, branching and intermediate results itself, and only its final return value comes back into your conversation. Use it for codebase-wide audits, many-file migrations, research that needs cross-checking, or drafting a hard plan from several independent angles.

```
ultracode: audit every route handler under src/routes/ for missing auth checks, and adversarially verify each finding
```

## Install

```bash
pi install git:github.com/rebehzat/pi-ultracode
```

## What you get

| | |
|---|---|
| `ultracode` keyword | Put it anywhere in a prompt you type to run that task as a workflow. The editor paints it in an animated rainbow. **Alt+W** dismisses it for that prompt. |
| `/ultracode [on\|off\|status]` | Ultracode mode: `xhigh` thinking + the model plans a workflow for every substantive task. An animated `⚡ultracode` badge appears on the editor border. `pi --ultracode` starts with it on. |
| `workflow` tool | What the model calls. Takes `script` (or `script_path`, or `name` of a saved workflow), optional `args`, and `resume` (a run id). |
| Live widget | Spinner, phase, agent counts, elapsed time and tokens for each running workflow, above the editor. |
| `/workflows` | Browse runs → phases/agents (prompt, tool calls, result), log, pause/resume, stop, stop/restart one agent, view script/result, **save as a command**. |
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

- `agent(prompt, { label, schema, model, thinking, tools, cwd, systemPrompt })`: one fresh `pi` subprocess (JSON mode) with its own context. It resolves to the final text, or to schema-validated JSON (invalid output is sent back to the same session for a fix, up to 5 tries). It resolves to `null` when the agent is stopped or fails.
- `parallel([...promises|fns])`, `pipeline(items, fn)`: fan out, wait for all. Rejections become `null`.
- `phase(title)`, `log(...)`, the `args` global, and top-level `return`.
- `Date.now()`, `new Date()` and `Math.random()` throw, and `import`/`require` are rejected, so a relaunch replays the same calls.

## How it runs

- Each run gets its own directory, `~/.pi/agent/ultracode/runs/<id>/`, holding `script.js`, `args.json`, `journal.jsonl`, `result.json`, and a session per agent under `agents/`.
- **Resume:** `workflow { resume: "<id>" }` starts a new run in which any agent whose prompt and options match a finished agent in the old run returns its saved result.
- **Concurrency:** `min(16, CPUs)` by default; override with `PI_WORKFLOW_MAX_CONCURRENT_AGENTS` (1–256). A run can start at most 1000 agents, and one `parallel()`/`pipeline()` call takes at most 4096 items.
- **Where it runs:** in the TUI and RPC modes, runs happen in the background and the result arrives as a follow-up message that starts a new turn. In `pi -p` / JSON mode, the tool waits for the run to finish.
- **Agents:** they use your session's model and thinking level unless the script or the config overrides them. They load your other pi extensions but cannot start nested workflows.
- **Sandboxing:** the script runs in a `node:vm` context. That keeps scripts deterministic but is **not** a security sandbox. Agents run with your normal pi tools and permissions.

## Config

Optional `~/.pi/agent/ultracode.json`:

```json
{
  "ultracode": false,
  "keywordTrigger": true,
  "sizeGuideline": "medium",
  "askBeforeRun": true,
  "rainbowEditor": true,
  "maxConcurrentAgents": 16,
  "maxStructuredRetries": 5,
  "agentModel": "anthropic/claude-sonnet-5",
  "agentThinking": "medium"
}
```

`sizeGuideline` is advice to the model, not a cap: `small` (<5 agents), `medium` (<10), `large` (<50), `unrestricted`. `rainbowEditor` swaps in pi's editor component; turn it off if another extension provides its own editor.

## Differences from Claude Code

- There is no git-worktree isolation for agents yet. Parallel agents share the working tree, and the model is told to give each agent a disjoint set of files.
- Resume matches finished agents by prompt and options; it does not rerun everything after the first changed agent.
- `/workflows` is built from pi's select and editor dialogs, not a dedicated full-screen view.
- There is no bundled `/deep-research`. Save your own workflow instead.

## Development

```bash
npm install
npm run typecheck
npm test          # runtime tests with a stubbed agent runner
pi -e ./extensions/ultracode/index.ts
```

## License

MIT
