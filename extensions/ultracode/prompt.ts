/**
 * Model-facing text: the workflow tool description (authoring reference) and
 * the ultracode guidance appended to the system prompt / user prompt.
 */

export type SizeGuideline = "small" | "medium" | "large" | "unrestricted";

export function sizeText(size: SizeGuideline): string {
	switch (size) {
		case "small":
			return "Size guideline: aim for fewer than 5 agents per workflow unless the user asks for more.";
		case "medium":
			return "Size guideline: aim for fewer than 10 agents per workflow unless the user asks for more.";
		case "large":
			return "Size guideline: aim for fewer than 50 agents per workflow unless the user asks for more.";
		default:
			return "Size guideline: none — size the workflow to the task.";
	}
}

export const TOOL_DESCRIPTION = `Launch a dynamic workflow: a JavaScript script that orchestrates many subagents in the background. The script holds the plan, loops and intermediate results; only its final return value comes back to you.

Use it when a task needs more agents than one conversation can coordinate (codebase-wide audits, many-file migrations, research that needs sources cross-checked, a hard plan drafted from several independent angles), or when the user asks for a workflow / says "ultracode".

The run starts in the background and this tool returns immediately. The final result arrives later as a follow-up message — do not poll, do not wait, do not launch the same workflow twice. You may keep talking to the user or end your turn.

## Inputs
- script: full JS source (preferred), or script_path: a .js file, or name: a saved workflow.
- args: optional JSON value exposed to the script as the global \`args\`.
- resume: id of an earlier run; agents whose prompt+options match a finished agent in that run return their saved result instead of running again.

## Script shape
\`\`\`js
export const meta = {
  name: 'audit-routes',                       // kebab-case, required
  description: 'Audit route handlers for missing auth',
  phases: ['Discover', 'Audit', 'Verify'],     // optional, must match phase() titles
}

phase('Discover')
const found = await agent('List every .ts file under src/routes/. Use find/ls.', {
  label: 'discover',
  schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },
})

phase('Audit')
const audits = await pipeline(found.files, file =>
  agent(\`Audit \${file} for missing authentication checks. Report concrete issues with line numbers, or "none".\`, {
    label: file,
    schema: { type: 'object', required: ['file', 'issues'], properties: {
      file: { type: 'string' },
      issues: { type: 'array', items: { type: 'object', required: ['line', 'problem'], properties: { line: { type: 'integer' }, problem: { type: 'string' } } } } } },
  }),
)

phase('Verify')
const flagged = audits.filter(a => a && a.issues.length)
const verified = await pipeline(flagged, a =>
  agent(\`Adversarially check these claimed issues in \${a.file}. Try to refute each one. Return only the issues that hold up.\\n\${JSON.stringify(a.issues)}\`, { label: 'verify ' + a.file, schema: { type: 'array', items: { type: 'object' } } }),
)
return flagged.map((a, i) => ({ file: a.file, issues: verified[i] ?? [] }))
\`\`\`

## Primitives (globals; plain JS with top-level await and top-level return)
- agent(prompt, opts?) → Promise. Spawns one fresh pi subagent with its own context and the normal tools (read/bash/edit/write…). It does NOT see this conversation: put every fact it needs in the prompt (paths, goals, constraints, output format). Resolves to the agent's final message text, or to the parsed JSON when opts.schema is given (validated; the agent is asked to fix invalid output, and the call throws if it still fails). Resolves null if the agent is stopped or hits an unrecoverable error.
  opts: { label, schema (JSON Schema), model ("provider/id"), thinking ("off"|"low"|"medium"|"high"|"xhigh"), tools (["read","bash",…]), cwd, systemPrompt }
- parallel([promiseOrFn, …]) → Promise<array>. Runs everything at once, waits for all. A rejection becomes null (and is logged) instead of failing the run.
- pipeline(items, (item, index) => promise) → Promise<array>. One task per item, all at once (the runtime caps real concurrency). Rejections become null. Always .filter(Boolean) before using results.
- phase(title): groups the agents started after it under a title in the progress view.
- log(...values): shows a message in the progress view.
- args: the args input (undefined if omitted).
- return value: JSON-serializable final result. Make it compact and decision-ready; it is all you get back.

## Rules
- No filesystem, shell, network, import() or require() in the script itself — agents do the work; the script coordinates.
- Date.now(), new Date() and Math.random() throw (runs must replay deterministically). Pass timestamps via args.
- Concurrency is capped by the runtime (default: min(16, CPUs)); 1000 agents max per run; 4096 items max per parallel/pipeline call.
- Parallel agents share the working tree: never let two agents edit the same file at once. For edits, give each agent a disjoint set of files, or have agents propose patches and apply them in a later single-agent phase.
- Prefer schemas for anything the script branches on. Keep prompts self-contained and specific.
- Good patterns: fan-out then adversarial verify; loop until a check passes or stops improving (while loop around agent calls with a round cap); several independent drafts then a judge; discover → shard → process → merge.
- Cost scales with agent count. Use cheaper models/thinking for mechanical stages via opts.model / opts.thinking.`;

export function ultracodeSystemPrompt(size: SizeGuideline): string {
	return `
# Ultracode mode (on)
The user turned on ultracode: maximum reasoning effort plus automatic dynamic-workflow orchestration. For every substantive task (anything beyond a quick question or a trivial edit), plan the work and run it with the \`workflow\` tool instead of working through it turn by turn. A single request may become several workflows in sequence — e.g. one to understand the code, one to make the change, one to verify it. Quality patterns matter more than raw agent count: independent drafts, adversarial verification of findings, and check-until-green loops. After a workflow's result arrives, synthesize it for the user and decide whether another workflow is needed.
${sizeText(size)}`;
}

export function keywordNote(size: SizeGuideline): string {
	return `\n\n[ultracode] The user opted in to a dynamic workflow for this task: design a workflow script for it and launch it with the \`workflow\` tool rather than doing the work turn by turn. ${sizeText(size)}`;
}
