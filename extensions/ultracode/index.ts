/**
 * pi-ultracode — Claude Code's "ultracode" / dynamic workflows for pi.
 *
 *   - `workflow` tool: the model writes a JS script that orchestrates many
 *     subagents (agent / parallel / pipeline / phase / log); it runs in the
 *     background and its return value comes back as a follow-up message.
 *   - `ultracode` keyword: opt a single prompt into a workflow (rainbow-highlighted
 *     in the editor; Alt+W dismisses it).
 *   - `/ultracode [on|off]`: xhigh thinking + automatic workflow orchestration.
 *   - `/workflows`: inspect, pause, stop and save runs; saved workflows become `/name` commands.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { DEPTH_ENV } from "./agent.ts";
import { keywordNote, type SizeGuideline, sizeText, TOOL_DESCRIPTION, ultracodeSystemPrompt } from "./prompt.ts";
import { KEYWORD_RE, rainbow, spinner, UltracodeEditor } from "./rainbow.ts";
import { deleteRun, listRuns, patchRun, type RunRecord, readRun, runIdsFromSession, runState } from "./registry.ts";
import { type AgentState, parseScript, runsRoot, safeStringify, withMeta, WorkflowRun } from "./runtime.ts";

interface Config {
	/** Start every session with ultracode on. */
	ultracode?: boolean;
	/** Let the `ultracode` keyword opt a prompt into a workflow. Default true. */
	keywordTrigger?: boolean;
	sizeGuideline?: SizeGuideline;
	maxConcurrentAgents?: number;
	maxStructuredRetries?: number;
	/** Ask before each run (skipped while ultracode is on). Default true. */
	askBeforeRun?: boolean;
	/** Replace the input editor with one that rainbow-highlights the keyword. Default true. */
	rainbowEditor?: boolean;
	/** Thinking level for workflow agents. Default: the session's current level. */
	agentThinking?: string;
	/** Model for workflow agents ("provider/id"). Default: the session's model. */
	agentModel?: string;
}

const CONFIG_PATH = path.join(getAgentDir(), "ultracode.json");
const PERSONAL_WORKFLOWS = path.join(getAgentDir(), "workflows");
const RESULT_TYPE = "ultracode-result";
const MODE_ENTRY = "ultracode-mode";
const MAX_RESULT_CHARS = 40_000;
const RESERVED = new Set(["ultracode", "workflows", "workflow"]);

function loadConfig(): Config {
	try {
		return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		return {};
	}
}

// ── saved workflows ────────────────────────────────────────────────────────

interface SavedWorkflow {
	name: string;
	description?: string;
	file: string;
	scope: "project" | "personal";
}

function findGitRoot(start: string): string | undefined {
	let dir = start;
	while (true) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Project workflow dirs from cwd up to the repo root (nearest first). */
function projectWorkflowDirs(cwd: string): string[] {
	const root = findGitRoot(cwd) ?? cwd;
	const dirs: string[] = [];
	let dir = cwd;
	while (true) {
		dirs.push(path.join(dir, ".pi", "workflows"));
		if (dir === root || dir === os.homedir()) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirs;
}

function discoverSaved(cwd: string): Map<string, SavedWorkflow> {
	const found = new Map<string, SavedWorkflow>();
	const scan = (dir: string, scope: SavedWorkflow["scope"]) => {
		let files: string[];
		try {
			files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
		} catch {
			return;
		}
		for (const f of files) {
			const file = path.join(dir, f);
			try {
				const { meta } = parseScript(fs.readFileSync(file, "utf8"), path.basename(f, ".js"));
				if (!found.has(meta.name)) found.set(meta.name, { name: meta.name, description: meta.description, file, scope });
			} catch {}
		}
	};
	// Nearest project dir wins, then project over personal.
	for (const dir of projectWorkflowDirs(cwd)) scan(dir, "project");
	scan(PERSONAL_WORKFLOWS, "personal");
	return found;
}

// ── formatting ─────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

const STATUS_ICON: Record<string, string> = {
	running: "●",
	paused: "⏸",
	done: "✓",
	failed: "✗",
	stopped: "■",
	interrupted: "⚠",
	queued: "○",
	cached: "↺",
};

function runLine(run: WorkflowRun): string {
	const c = run.counts();
	const parts = [
		`${STATUS_ICON[run.status]} ${fmtDuration((run.endedAt ?? Date.now()) - run.startedAt).padStart(6)}`,
		run.meta.name,
		`${c.done}/${c.total} agents`,
	];
	if (c.running) parts.push(`${c.running} running`);
	if (c.failed) parts.push(`${c.failed} failed`);
	parts.push(`↑${fmtTokens(run.usage.input)} ↓${fmtTokens(run.usage.output)}`);
	return parts.join(" · ");
}

function agentLine(a: AgentState): string {
	const dur = a.startedAt ? fmtDuration((a.endedAt ?? Date.now()) - a.startedAt) : "";
	const phase = a.phase ? `[${a.phase}] ` : "";
	return `${STATUS_ICON[a.status]} ${phase}${a.label}${dur ? ` · ${dur}` : ""}${a.usage.output ? ` · ↓${fmtTokens(a.usage.output)}` : ""}`;
}

function agentDetail(a: AgentState): string {
	const out = [
		`# Agent #${a.index} — ${a.label}`,
		`status: ${a.status}${a.model ? ` · model: ${a.model}` : ""}${a.phase ? ` · phase: ${a.phase}` : ""}`,
		`usage: ↑${fmtTokens(a.usage.input)} ↓${fmtTokens(a.usage.output)} · ${a.usage.turns} turns · $${a.usage.cost.toFixed(4)}`,
		"",
		"## Prompt",
		a.prompt,
		"",
		"## Tool calls",
		...(a.activity.length ? a.activity.map((s) => `- ${s}`) : ["(none yet)"]),
	];
	if (a.error) out.push("", "## Error", a.error);
	if (a.result !== undefined) {
		out.push("", "## Result", typeof a.result === "string" ? a.result : safeStringify(a.result, 2));
	}
	return out.join("\n");
}

function formatResult(run: WorkflowRun): string {
	const c = run.counts();
	const head =
		`Workflow "${run.meta.name}" (run ${run.id}) ${run.status} after ${fmtDuration((run.endedAt ?? Date.now()) - run.startedAt)} · ` +
		`${c.total} agents (${c.done} ok, ${c.failed} failed) · ↑${fmtTokens(run.usage.input)} ↓${fmtTokens(run.usage.output)}` +
		(run.usage.cost ? ` · $${run.usage.cost.toFixed(2)}` : "");
	const lines = [head, `Script: ${run.scriptPath}`, `Full result: ${path.join(run.runDir, "result.json")}`];
	if (run.error) lines.push("", "Error:", run.error.slice(0, 4000));
	if (run.logs.length) lines.push("", "Log (last 10):", ...run.logs.slice(-10).map((l) => `  ${l}`));
	if (run.status === "done") {
		let body = typeof run.result === "string" ? run.result : safeStringify(run.result, 2);
		if (body.length > MAX_RESULT_CHARS) {
			body = `${body.slice(0, MAX_RESULT_CHARS)}\n… [truncated ${body.length - MAX_RESULT_CHARS} chars — read the full result file]`;
		}
		lines.push("", "<workflow-result>", body, "</workflow-result>");
	} else if (run.status === "stopped" || run.status === "interrupted") {
		lines.push("", `The run was stopped. Relaunch with workflow { resume: "${run.id}" } to reuse finished agents.`);
	}
	return lines.join("\n");
}

// ── extension ──────────────────────────────────────────────────────────────

export default function ultracode(pi: ExtensionAPI) {
	// Workflow agents are plain pi processes: no nested workflows.
	if (Number(process.env[DEPTH_ENV] ?? 0) > 0) return;

	let config = loadConfig();
	const runs: WorkflowRun[] = [];
	let ctxRef: ExtensionContext | undefined;
	let modeOn = false;
	let previousThinking: string | undefined;
	let turnIsUltracode = false;
	let allowAllThisSession = false;
	const allowedNames = new Set<string>();
	let editor: UltracodeEditor | undefined;
	let frame = 0;
	/** This session's runs that this process isn't executing: interrupted, or owned by another pi process. */
	let detached: { run: RunRecord; state: "interrupted" | "elsewhere" }[] = [];

	function refreshDetached(ctx: ExtensionContext): void {
		let sessionId: string | undefined;
		let sessionRunIds = new Set<string>();
		try {
			sessionId = ctx.sessionManager.getSessionId();
			sessionRunIds = runIdsFromSession(ctx.sessionManager.getBranch() as any[]);
		} catch {}
		const liveIds = new Set(runs.filter((r) => r.running).map((r) => r.id));
		detached = [];
		for (const r of listRuns()) {
			if (r.resumedBy || r.dismissed) continue;
			if (!(r.sessionId ? r.sessionId === sessionId : sessionRunIds.has(r.id))) continue;
			const state = runState(r, liveIds);
			if (state === "interrupted" || state === "elsewhere") detached.push({ run: r, state });
		}
	}

	async function resumeDetached(id: string, ctx: ExtensionContext): Promise<void> {
		const dir = path.join(runsRoot(), id);
		const source = await approve(ctx, fs.readFileSync(path.join(dir, "script.js"), "utf8"));
		if (!source) return;
		let args: unknown;
		try {
			args = JSON.parse(fs.readFileSync(path.join(dir, "args.json"), "utf8")) ?? undefined;
		} catch {}
		const { run } = launch(ctx, source, args, { resume: id, background: ctx.mode === "tui" || ctx.mode === "rpc" });
		patchRun(id, { resumedBy: run.id });
		refreshDetached(ctx);
		refreshUI();
		ctx.ui.notify(`Resumed ${run.meta.name} as ${run.id}; finished agents are reused`, "info");
	}
	let ticker: ReturnType<typeof setInterval> | undefined;
	const registeredSaved = new Set<string>();

	const size = (): SizeGuideline => config.sizeGuideline ?? "medium";
	const animating = () => modeOn || turnIsUltracode || runs.some((r) => r.running);

	// ── animation / status ──

	function refreshUI(): void {
		const ctx = ctxRef;
		if (!ctx || ctx.mode !== "tui") return;
		const theme = ctx.ui.theme;
		ctx.ui.setStatus("ultracode", modeOn ? rainbow("⚡ultracode", frame, { bold: true }) : undefined);
		if (turnIsUltracode || modeOn) ctx.ui.setWorkingMessage(rainbow("Ultracoding…", frame));

		const active = runs.filter((r) => r.running);
		if (!active.length && !detached.length) {
			ctx.ui.setWidget("ultracode", undefined);
			return;
		}
		const lines = active.map((r) => {
			const c = r.counts();
			const icon = r.status === "paused" ? theme.fg("warning", "⏸") : theme.fg("accent", spinner(frame));
			const bits = [
				r.currentPhase,
				`${c.done}/${c.total} agents`,
				c.running ? `${c.running} running` : undefined,
				c.failed ? theme.fg("error", `${c.failed} failed`) : undefined,
				fmtDuration(Date.now() - r.startedAt),
				`↑${fmtTokens(r.usage.input)} ↓${fmtTokens(r.usage.output)}`,
			].filter(Boolean);
			return `${icon} ${rainbow(r.meta.name, frame)} ${theme.fg("muted", `· ${bits.join(" · ")}`)}`;
		});
		// Runs of this session that this pi process isn't executing (it was restarted, or another pi owns them).
		for (const d of detached) {
			lines.push(
				d.state === "elsewhere"
					? `${theme.fg("accent", "●")} ${d.run.name} ${theme.fg("muted", `· running in another pi process (pid ${d.run.pid}) · ${d.run.done}/${d.run.total} agents done`)}`
					: `${theme.fg("warning", "⚠")} ${d.run.name} ${theme.fg("muted", `· interrupted, not running · ${d.run.done}/${d.run.total} agents done`)}`,
			);
		}
		lines.push(
			theme.fg(
				"dim",
				detached.some((d) => d.state === "interrupted") ? "  /workflows to inspect · resume · stop" : "  /workflows to inspect · pause · stop",
			),
		);
		ctx.ui.setWidget("ultracode", lines);
	}

	function syncTicker(): void {
		const want = !!ctxRef && ctxRef.mode === "tui" && animating();
		if (want && !ticker) {
			ticker = setInterval(() => {
				frame++;
				refreshUI();
				if (!animating()) syncTicker();
			}, 90);
		} else if (!want && ticker) {
			clearInterval(ticker);
			ticker = undefined;
			refreshUI();
		}
	}

	/** `restoredPrevious`: the pre-ultracode thinking level saved in the session, when restoring on resume. */
	function setMode(on: boolean, ctx: ExtensionContext, persist = true, restoredPrevious?: string): void {
		if (on === modeOn) return;
		modeOn = on;
		if (on) {
			previousThinking = restoredPrevious ?? pi.getThinkingLevel();
			pi.setThinkingLevel("xhigh");
		} else {
			pi.setThinkingLevel((previousThinking as any) ?? "high");
			ctx.ui.setWorkingMessage();
		}
		// Save the level to go back to, so turning ultracode off after a resume restores it too.
		if (persist) pi.appendEntry(MODE_ENTRY, on ? { on, previousThinking } : { on });
		editor?.setBadge(on);
		ctxRef = ctx;
		syncTicker();
		refreshUI();
	}

	// ── running workflows ──

	function defaults(ctx: ExtensionContext) {
		const envMax = Number(process.env.PI_WORKFLOW_MAX_CONCURRENT_AGENTS);
		let sessionId: string | undefined;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {}
		return {
			cwd: ctx.cwd,
			sessionId,
			model: config.agentModel ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
			thinking: config.agentThinking ?? pi.getThinkingLevel(),
			maxConcurrent: Math.max(
				1,
				Math.min(256, envMax || config.maxConcurrentAgents || Math.min(16, os.availableParallelism?.() ?? os.cpus().length)),
			),
			maxStructuredRetries: Number(process.env.MAX_STRUCTURED_OUTPUT_RETRIES) || config.maxStructuredRetries || 5,
		};
	}

	async function approve(ctx: ExtensionContext, source: string, savedName?: string): Promise<string | undefined> {
		if (!ctx.hasUI || config.askBeforeRun === false || modeOn || allowAllThisSession) return source;
		if (savedName && allowedNames.has(savedName)) return source;
		while (true) {
			const { meta } = parseScript(source);
			const phases = meta.phases?.length ? ` · phases: ${meta.phases.join(" → ")}` : "";
			const options = [
				"Yes, run it",
				savedName ? `Yes, and don't ask again for ${savedName} this session` : "Yes, and don't ask again this session",
				"View / edit script",
				"No",
			];
			const choice = await ctx.ui.select(
				`Run workflow "${meta.name}"?${meta.description ? ` — ${meta.description}` : ""}${phases} (spawns background agents; uses more tokens)`,
				options,
			);
			if (choice === options[0]) return source;
			if (choice === options[1]) {
				if (savedName) allowedNames.add(savedName);
				else allowAllThisSession = true;
				return source;
			}
			if (choice === options[2]) {
				const edited = await ctx.ui.editor(`Workflow script: ${meta.name}`, source);
				if (edited?.trim()) {
					try {
						parseScript(edited);
						source = edited;
					} catch (e) {
						ctx.ui.notify(`Edited script is invalid: ${(e as Error).message}`, "error");
					}
				}
				continue;
			}
			return undefined;
		}
	}

	function launch(
		ctx: ExtensionContext,
		source: string,
		args: unknown,
		opts: { resume?: string; background: boolean },
	): { run: WorkflowRun; done: Promise<void> } {
		const parsed = parseScript(source);
		const run = new WorkflowRun(source, parsed, args, defaults(ctx), opts.resume);
		runs.push(run);
		ctxRef = ctx;
		run.onChange(() => {
			if (!ticker) refreshUI();
		});
		syncTicker();
		const done = run.start().then(() => {
			syncTicker();
			if (!opts.background) return;
			const ok = run.status === "done";
			ctxRef?.ui.notify(
				`Workflow ${run.meta.name} ${run.status}${ok ? "" : " — see /workflows"}`,
				ok ? "info" : run.status === "stopped" ? "warning" : "error",
			);
			pi.sendMessage(
				{ customType: RESULT_TYPE, content: formatResult(run), display: true, details: run.summary() },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		});
		return { run, done };
	}

	// ── tool ──

	pi.registerTool({
		name: "workflow",
		label: "Workflow",
		description: TOOL_DESCRIPTION,
		promptSnippet: "workflow: run a JS orchestration script that fans work out to many background subagents (dynamic workflows / ultracode)",
		promptGuidelines: [
			"Use the workflow tool when the user asks for a workflow or says ultracode, or when a task needs many agents (audits, migrations, cross-checked research). Its result arrives later as a follow-up message; never poll or relaunch it.",
		],
		parameters: Type.Object({
			script: Type.Optional(Type.String({ description: "Full workflow script source, starting with `export const meta = {...}`." })),
			script_path: Type.Optional(Type.String({ description: "Path to a workflow .js file (alternative to script)." })),
			name: Type.Optional(Type.String({ description: "Name of a saved workflow to run." })),
			args: Type.Optional(Type.Unknown({ description: "JSON value exposed to the script as the global `args`." })),
			resume: Type.Optional(
				Type.String({ description: "Run id to relaunch; finished agents with identical prompts return their saved results." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			let source: string | undefined;
			if (params.script) source = params.script;
			else if (params.script_path) source = fs.readFileSync(path.resolve(ctx.cwd, params.script_path), "utf8");
			else if (params.name) {
				const saved = discoverSaved(ctx.cwd).get(params.name);
				if (!saved) {
					const names = [...discoverSaved(ctx.cwd).keys()].join(", ") || "none";
					throw new Error(`No saved workflow named "${params.name}". Saved: ${names}`);
				}
				source = fs.readFileSync(saved.file, "utf8");
			} else if (params.resume) {
				const file = path.join(runsRoot(), params.resume, "script.js");
				if (!fs.existsSync(file)) throw new Error(`nothing to resume: no run ${params.resume}`);
				source = fs.readFileSync(file, "utf8");
			}
			if (!source) throw new Error("Provide one of: script, script_path, name, resume.");
			parseScript(source); // fail fast on syntax-level problems

			const approved = await approve(ctx, source, params.name);
			if (!approved) throw new Error("The user declined to run this workflow. Ask what they would like to change.");

			const background = ctx.mode === "tui" || ctx.mode === "rpc";
			const { run, done } = launch(ctx, approved, params.args, { resume: params.resume, background });
			if (params.resume) {
				patchRun(params.resume, { resumedBy: run.id });
				refreshDetached(ctx);
			}
			const details = { runId: run.id, name: run.meta.name, scriptPath: run.scriptPath, background };
			if (!background) {
				await done;
				return { content: [{ type: "text", text: formatResult(run) }], details, isError: run.status !== "done" } as any;
			}
			return {
				content: [
					{
						type: "text",
						text:
							`Workflow "${run.meta.name}" started in the background as run ${run.id}.\n` +
							`Script: ${run.scriptPath}\n` +
							"The final result will arrive as a follow-up message. Do not poll, wait, or relaunch it; " +
							"tell the user it is running (they can watch it with /workflows) and end your turn unless there is other independent work.",
					},
				],
				details,
			};
		},
		renderCall(args, theme) {
			const name =
				(args.script && /name\s*:\s*['"`]([^'"`]+)/.exec(args.script)?.[1]) ||
				args.name ||
				args.script_path ||
				(args.resume ? `resume ${args.resume}` : "…");
			return new Text(`${theme.fg("toolTitle", theme.bold("workflow "))}${rainbow(String(name), 0)}`, 0, 0);
		},
	});

	// ── management tool (lets the agent inspect, control and clean up runs) ──

	const MANAGE_ACTIONS = ["list", "status", "pause", "resume", "stop", "dismiss", "delete", "delete_saved"] as const;
	type ManageAction = (typeof MANAGE_ACTIONS)[number];
	const liveIds = () => new Set(runs.filter((r) => r.running).map((r) => r.id));
	const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n… [truncated]` : text);

	function describeLive(run: WorkflowRun): string {
		const c = run.counts();
		const lines = [
			`${run.id} (${run.meta.name}) — ${run.status}${run.currentPhase ? ` · phase: ${run.currentPhase}` : ""}`,
			`agents: ${c.done} done, ${c.running} running, ${c.failed} failed, ${c.total} started · ${fmtDuration((run.endedAt ?? Date.now()) - run.startedAt)} · ↑${fmtTokens(run.usage.input)} ↓${fmtTokens(run.usage.output)}`,
			`script: ${run.scriptPath}`,
		];
		if (run.agents.length) lines.push("", "Agents:", ...run.agents.slice(-60).map((a) => `  #${a.index} ${agentLine(a)}${a.error ? ` — ${a.error.slice(0, 200)}` : ""}`));
		if (run.logs.length) lines.push("", "Log (last 10):", ...run.logs.slice(-10).map((l) => `  ${l}`));
		if (!run.running) lines.push("", truncate(formatResult(run), 20_000));
		return lines.join("\n");
	}

	function describeRecord(r: RunRecord, state: string): string {
		const lines = [
			`${r.id} (${r.name}) — ${state === "interrupted" ? "INTERRUPTED (not running; resume with workflow { resume })" : state === "elsewhere" ? `running in another pi process (pid ${r.pid})` : r.status}`,
			`agents: ${r.done}/${r.total} finished · started ${new Date(r.startedAt).toISOString()}`,
			`script: ${path.join(runsRoot(), r.id, "script.js")}`,
		];
		const resultFile = path.join(runsRoot(), r.id, "result.json");
		if (fs.existsSync(resultFile)) lines.push(`result: ${resultFile}`, "", truncate(fs.readFileSync(resultFile, "utf8"), 20_000));
		return lines.join("\n");
	}

	pi.registerTool({
		name: "workflow_manage",
		label: "Workflow manage",
		description:
			"Inspect and manage dynamic workflow runs and saved workflows. Actions: " +
			"list (runs in this pi, this session's interrupted runs, recent runs on disk, saved workflows); " +
			"status {id} (progress, agents, log, result); pause/resume/stop {id} (runs executing in this pi); " +
			"dismiss {id} (hide an interrupted run); delete {id} (permanently remove a finished/stopped/interrupted run's files); " +
			"delete_saved {name} (remove a saved workflow command). " +
			"To relaunch an interrupted or stopped run, use the workflow tool with { resume: id }, not this tool. " +
			"Don't poll status in a loop: a running workflow's result arrives by itself as a follow-up message.",
		promptSnippet: "workflow_manage: list, inspect, pause/resume/stop, dismiss and delete workflow runs and saved workflows",
		parameters: Type.Object({
			action: Type.Unsafe<ManageAction>({ type: "string", enum: [...MANAGE_ACTIONS], description: "What to do" }),
			id: Type.Optional(Type.String({ description: "Run id (for status, pause, resume, stop, dismiss, delete)" })),
			name: Type.Optional(Type.String({ description: "Saved workflow name (for delete_saved)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			refreshDetached(ctx);
			const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: { action: params.action } });
			const live = params.id ? runs.find((r) => r.id === params.id) : undefined;
			const needId = () => {
				if (!params.id) throw new Error(`action "${params.action}" needs an id`);
				return params.id;
			};

			switch (params.action) {
				case "list": {
					const lines: string[] = [];
					const mine = [...runs].reverse();
					lines.push(`Runs in this pi process (${mine.length}):`, ...(mine.length ? mine.map((r) => `  ${runLine(r)} · ${r.id}`) : ["  (none)"]));
					lines.push(
						"",
						`This session's runs not executing here (${detached.length}):`,
						...(detached.length
							? detached.map((d) => `  ${d.state === "elsewhere" ? `● in pi pid ${d.run.pid}` : "⚠ interrupted"} · ${d.run.name} · ${d.run.done}/${d.run.total} agents · ${d.run.id}`)
							: ["  (none)"]),
					);
					const known = new Set([...mine.map((r) => r.id), ...detached.map((d) => d.run.id)]);
					const others = listRuns().filter((r) => !known.has(r.id)).slice(0, 15);
					lines.push("", `Other recent runs on disk (${others.length} shown):`, ...(others.length ? others.map((r) => `  ${runState(r, liveIds())} · ${r.status} · ${r.name} · ${r.done}/${r.total} agents · ${r.id}`) : ["  (none)"]));
					const saved = [...discoverSaved(ctx.cwd).values()];
					lines.push("", `Saved workflows (${saved.length}):`, ...(saved.length ? saved.map((w) => `  /${w.name} (${w.scope}) ${w.file}`) : ["  (none)"]));
					return text(lines.join("\n"));
				}
				case "status": {
					const id = needId();
					if (live) return text(describeLive(live));
					const rec = readRun(id);
					if (!rec) throw new Error(`no workflow run "${id}"`);
					return text(describeRecord(rec, runState(rec, liveIds())));
				}
				case "pause":
				case "resume":
				case "stop": {
					const id = needId();
					if (!live || !live.running) {
						const rec = readRun(id);
						const state = rec ? runState(rec, liveIds()) : undefined;
						if (!rec) throw new Error(`no workflow run "${id}"`);
						if (state === "elsewhere") throw new Error(`run ${id} is executing in another pi process (pid ${rec.pid}); control it from there`);
						if (params.action === "resume" && state === "interrupted") {
							throw new Error(`run ${id} is interrupted, not paused. Relaunch it with the workflow tool: { resume: "${id}" }`);
						}
						throw new Error(`run ${id} is not executing in this pi (status: ${rec.status})`);
					}
					if (params.action === "pause") live.pause();
					else if (params.action === "resume") live.resume();
					else live.stop();
					refreshUI();
					return text(`${params.action === "stop" ? "Stopped" : params.action === "pause" ? "Paused" : "Resumed"} ${id}. Status: ${live.status}.`);
				}
				case "dismiss": {
					const id = needId();
					if (!readRun(id)) throw new Error(`no workflow run "${id}"`);
					patchRun(id, { dismissed: true });
					refreshDetached(ctx);
					refreshUI();
					return text(`Dismissed ${id}; it no longer shows as interrupted. Its files are kept.`);
				}
				case "delete": {
					const id = needId();
					const rec = readRun(id);
					if (!rec) throw new Error(`no workflow run "${id}"`);
					const res = deleteRun(id, liveIds());
					if (!res.ok) throw new Error(res.error);
					const i = runs.findIndex((r) => r.id === id);
					if (i >= 0) runs.splice(i, 1);
					refreshDetached(ctx);
					refreshUI();
					return text(`Deleted workflow run ${id}.`);
				}
				case "delete_saved": {
					if (!params.name) throw new Error('action "delete_saved" needs a name');
					const saved = discoverSaved(ctx.cwd).get(params.name);
					if (!saved) throw new Error(`no saved workflow "${params.name}"`);
					fs.rmSync(saved.file);
					return text(`Deleted saved workflow /${saved.name} (${saved.file}). The command disappears after /reload.`);
				}
				default:
					throw new Error(`unknown action "${params.action}"`);
			}
		},
	});

	pi.registerMessageRenderer(RESULT_TYPE, (message, { expanded }, theme) => {
		const d = (message.details ?? {}) as any;
		const status = String(d.status ?? "done");
		const color = status === "done" ? "success" : status === "stopped" ? "warning" : "error";
		const c = d.agents ?? {};
		const head =
			`${theme.fg(color, STATUS_ICON[status] ?? "●")} ${rainbow("workflow", 3, { bold: true })} ${theme.bold(String(d.name ?? ""))} ` +
			theme.fg("muted", `· ${status} · ${c.total ?? 0} agents · ${fmtDuration(Number(d.durationMs ?? 0))}`);
		const text = typeof message.content === "string" ? message.content : "";
		const lines = text.split("\n");
		const body = expanded ? text : lines.slice(0, 12).join("\n") + (lines.length > 12 ? `\n… ${lines.length - 12} more lines` : "");
		return new Text(`${head}\n${theme.fg("customMessageText", body)}`, 0, 0);
	});

	// ── commands ──

	pi.registerFlag("ultracode", { type: "boolean", description: "Start with ultracode on (xhigh thinking + automatic workflows)" });

	pi.registerCommand("ultracode", {
		description: "Toggle ultracode: xhigh thinking + automatic dynamic workflows (on|off|status)",
		getArgumentCompletions: (prefix) =>
			["on", "off", "status"].filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o })),
		handler: async (arg, ctx) => {
			ctxRef = ctx;
			const a = arg.trim().toLowerCase();
			if (a === "status") {
				ctx.ui.notify(`ultracode is ${modeOn ? "on" : "off"} · ${sizeText(size())}`, "info");
				return;
			}
			const next = a === "on" ? true : a === "off" ? false : !modeOn;
			setMode(next, ctx);
			ctx.ui.notify(
				next
					? `${rainbow("ultracode", 0, { bold: true })} on — xhigh thinking, Claude plans a workflow for each substantive task`
					: `ultracode off — thinking back to ${pi.getThinkingLevel()}`,
				"info",
			);
		},
	});

	pi.registerCommand("workflows", {
		description: "List workflow runs: inspect phases and agents, pause, stop, save as command",
		handler: async (_arg, ctx) => {
			ctxRef = ctx;
			while (true) {
				refreshDetached(ctx);
				const list = [...runs].reverse();
				const labels = list.map((r) => `${runLine(r)} · ${r.id}`);
				const detachedLabels = detached.map(
					(d) =>
						`${d.state === "elsewhere" ? "● in another pi" : "⚠ interrupted"} · ${d.run.name} · ${d.run.done}/${d.run.total} agents done · ${d.run.id}`,
				);
				const saved = [...discoverSaved(ctx.cwd).values()];
				const savedLabel = saved.length ? `Saved workflows (${saved.length}) …` : undefined;
				if (!labels.length && !detachedLabels.length && !savedLabel) {
					ctx.ui.notify("No workflow runs in this session yet.", "info");
					return;
				}
				const pick = await ctx.ui.select("Workflows", [...labels, ...detachedLabels, ...(savedLabel ? [savedLabel] : [])]);
				if (!pick) return;
				if (pick === savedLabel) {
					await savedMenu(ctx);
					continue;
				}
				const i = labels.indexOf(pick);
				if (i >= 0) await runMenu(list[i]!, ctx);
				else await detachedMenu(detached[detachedLabels.indexOf(pick)]!, ctx);
			}
		},
	});

	async function savedMenu(ctx: ExtensionContext): Promise<void> {
		while (true) {
			const saved = [...discoverSaved(ctx.cwd).values()];
			if (!saved.length) return;
			const labels = saved.map((w) => `/${w.name} · ${w.scope}${w.description ? ` · ${w.description}` : ""}`);
			const pick = await ctx.ui.select("Saved workflows", [...labels, "Back"]);
			if (!pick || pick === "Back") return;
			const w = saved[labels.indexOf(pick)]!;
			const act = await ctx.ui.select(`/${w.name} — ${w.file}`, ["View script", "Delete", "Back"]);
			if (act === "View script") await ctx.ui.editor(`${w.file} (edits here are not saved)`, fs.readFileSync(w.file, "utf8"));
			else if (act === "Delete") {
				fs.rmSync(w.file);
				ctx.ui.notify(`Deleted /${w.name}; the command disappears after /reload`, "info");
			}
		}
	}

	async function detachedMenu(d: { run: RunRecord; state: "interrupted" | "elsewhere" }, ctx: ExtensionContext): Promise<void> {
		const r = d.run;
		const actions =
			d.state === "interrupted"
				? [`Resume (reuses the ${r.done} finished agents)`, "View script", "Dismiss", "Delete", "Back"]
				: ["View script", "Back"];
		const title =
			d.state === "interrupted"
				? `${r.name} was interrupted when its pi process exited; it is not running`
				: `${r.name} is running in another pi process (pid ${r.pid}); manage it from there`;
		const choice = await ctx.ui.select(title, actions);
		if (!choice || choice === "Back") return;
		if (choice.startsWith("Resume")) await resumeDetached(r.id, ctx);
		else if (choice === "View script") {
			await ctx.ui.editor(`Script — ${r.id} (edits here are not saved)`, fs.readFileSync(path.join(runsRoot(), r.id, "script.js"), "utf8"));
		} else if (choice === "Dismiss") {
			patchRun(r.id, { dismissed: true });
			refreshDetached(ctx);
			refreshUI();
		} else if (choice === "Delete") {
			const res = deleteRun(r.id, new Set(runs.filter((x) => x.running).map((x) => x.id)));
			ctx.ui.notify(res.ok ? `Deleted ${r.id}` : res.error, res.ok ? "info" : "error");
			refreshDetached(ctx);
			refreshUI();
		}
	}

	async function runMenu(run: WorkflowRun, ctx: ExtensionContext): Promise<void> {
		while (true) {
			const actions = [
				"Agents",
				run.logs.length ? `Log (${run.logs.length})` : undefined,
				run.status === "running" ? "Pause" : run.status === "paused" ? "Resume" : undefined,
				run.running ? "Stop run" : undefined,
				"View script",
				"Save as command",
				!run.running ? "View result" : undefined,
				!run.running ? "Delete run" : undefined,
				"Back",
			].filter((x): x is string => !!x);
			const choice = await ctx.ui.select(runLine(run), actions);
			if (!choice || choice === "Back") return;
			if (choice === "Agents") await agentsMenu(run, ctx);
			else if (choice.startsWith("Log")) await ctx.ui.editor(`Log — ${run.meta.name}`, run.logs.join("\n"));
			else if (choice === "Pause") run.pause();
			else if (choice === "Resume") run.resume();
			else if (choice === "Stop run") {
				if (await ctx.ui.confirm("Stop workflow?", `Stop ${run.meta.name}? Finished agents are kept for a relaunch.`)) run.stop();
			} else if (choice === "View script") await ctx.ui.editor(`Script — ${run.scriptPath} (edits here are not saved)`, run.source);
			else if (choice === "View result") await ctx.ui.editor(`Result — ${run.meta.name}`, formatResult(run));
			else if (choice === "Save as command") await saveRun(run, ctx);
			else if (choice === "Delete run") {
				const res = deleteRun(run.id, new Set(runs.filter((r) => r.running).map((r) => r.id)));
				if (!res.ok) ctx.ui.notify(res.error, "error");
				else {
					runs.splice(runs.indexOf(run), 1);
					ctx.ui.notify(`Deleted ${run.id}`, "info");
					return;
				}
			}
		}
	}

	async function agentsMenu(run: WorkflowRun, ctx: ExtensionContext): Promise<void> {
		while (true) {
			if (!run.agents.length) {
				ctx.ui.notify("No agents have started yet.", "info");
				return;
			}
			const labels = run.agents.map((a) => `#${a.index} ${agentLine(a)}`);
			const pick = await ctx.ui.select(`${run.meta.name} — agents`, [...labels, "Back"]);
			if (!pick || pick === "Back") return;
			const agent = run.agents[labels.indexOf(pick)]!;
			const actions = ["View detail", ...(agent.status === "running" ? ["Stop agent", "Restart agent"] : []), "Back"];
			const act = await ctx.ui.select(`#${agent.index} ${agent.label}`, actions);
			if (act === "View detail") await ctx.ui.editor(`Agent #${agent.index} (read-only)`, agentDetail(agent));
			else if (act === "Stop agent") run.stopAgent(agent.index);
			else if (act === "Restart agent") run.restartAgent(agent.index);
		}
	}

	async function saveRun(run: WorkflowRun, ctx: ExtensionContext): Promise<void> {
		const gitRoot = findGitRoot(ctx.cwd);
		const projectDir =
			projectWorkflowDirs(ctx.cwd).find((d) => fs.existsSync(d)) ?? path.join(gitRoot ?? ctx.cwd, ".pi", "workflows");
		const projectLabel = `Project — ${path.relative(ctx.cwd, projectDir) || projectDir} (shared with the repo)`;
		const personalLabel = `Personal — ${PERSONAL_WORKFLOWS} (all projects)`;
		const where = await ctx.ui.select("Save workflow to", [projectLabel, personalLabel]);
		if (!where) return;
		const dir = where === projectLabel ? projectDir : PERSONAL_WORKFLOWS;
		const name = ((await ctx.ui.input("Command name", run.meta.name)) || run.meta.name).trim();
		if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name) || RESERVED.has(name)) {
			ctx.ui.notify(`Invalid command name "${name}"`, "error");
			return;
		}
		const file = path.join(dir, `${name}.js`);
		// Refuse to write through symlinks (project: .pi, .pi/workflows and the file; personal: the file only).
		const mustNotBeLinks = where === projectLabel ? [path.dirname(dir), dir, file] : [file];
		for (const p of mustNotBeLinks) {
			try {
				if (fs.lstatSync(p).isSymbolicLink()) {
					ctx.ui.notify(`Refusing to save: ${p} is a symlink`, "error");
					return;
				}
			} catch {}
		}
		if (fs.existsSync(file) && !(await ctx.ui.confirm("Overwrite?", `${file} exists. Overwrite it?`))) return;
		fs.mkdirSync(dir, { recursive: true });
		const source = name === run.meta.name ? run.source : withMeta(run.source, { ...run.meta, name });
		fs.writeFileSync(file, source);
		registerSaved({ name, description: run.meta.description, file, scope: where === projectLabel ? "project" : "personal" });
		ctx.ui.notify(`Saved ${file} — run it with /${name}`, "info");
	}

	function registerSaved(w: SavedWorkflow): void {
		if (registeredSaved.has(w.name) || RESERVED.has(w.name)) return;
		registeredSaved.add(w.name);
		pi.registerCommand(w.name, {
			description: `${w.description ?? "Saved workflow"} (workflow, ${w.scope})`,
			handler: async (argText, ctx) => {
				ctxRef = ctx;
				const saved = discoverSaved(ctx.cwd).get(w.name);
				if (!saved) {
					ctx.ui.notify(`Workflow ${w.name} not found in this project`, "error");
					return;
				}
				const text = argText.trim();
				let args: unknown;
				if (text) {
					try {
						args = JSON.parse(text);
					} catch {
						// Free-form input: let the model turn it into structured args.
						pi.sendUserMessage(
							`Run the saved workflow "${w.name}" with the workflow tool (name: "${w.name}"), passing args derived from this request: ${text}`,
						);
						return;
					}
				}
				const source = await approve(ctx, fs.readFileSync(saved.file, "utf8"), w.name);
				if (!source) return;
				launch(ctx, source, args, { background: ctx.mode === "tui" || ctx.mode === "rpc" });
				ctx.ui.notify(`Started workflow ${w.name} — /workflows to watch`, "info");
			},
		});
	}

	for (const w of discoverSaved(process.cwd()).values()) registerSaved(w);

	// ── events ──

	pi.on("session_start", (event, ctx) => {
		ctxRef = ctx;
		config = loadConfig();
		allowAllThisSession = false;
		allowedNames.clear();
		if (ctx.mode === "tui" && config.rainbowEditor !== false && config.keywordTrigger !== false) {
			ctx.ui.setEditorComponent((tui, theme, kb) => {
				editor = new UltracodeEditor(tui, theme, kb);
				if (modeOn) editor.setBadge(true);
				return editor;
			});
		}
		let restored: boolean | undefined;
		let restoredPrevious: string | undefined;
		if (event.reason === "resume" || event.reason === "fork" || event.reason === "reload") {
			for (const entry of ctx.sessionManager.getBranch() as any[]) {
				if (entry?.type === "custom" && entry.customType === MODE_ENTRY) {
					restored = !!entry.data?.on;
					restoredPrevious = entry.data?.previousThinking;
				}
			}
		}
		const want = restored ?? (!!pi.getFlag("ultracode") || !!config.ultracode);
		// The new session brings its own thinking level; don't carry the old session's over.
		modeOn = false;
		previousThinking = undefined;
		if (want) setMode(true, ctx, false, restored ? restoredPrevious : undefined);
		refreshDetached(ctx);
		const interrupted = detached.filter((d) => d.state === "interrupted").length;
		if (interrupted && ctx.hasUI) {
			ctx.ui.notify(`${interrupted} workflow run${interrupted === 1 ? "" : "s"} from this session ${interrupted === 1 ? "was" : "were"} interrupted — /workflows to resume`, "warning");
		}
		syncTicker();
		refreshUI();
	});

	pi.on("input", (event) => {
		const dismissed = editor?.submittedDismissed ?? false;
		if (editor) editor.submittedDismissed = false;
		if (config.keywordTrigger === false || dismissed) return { action: "continue" };
		// Only prompts a person typed: not extension-injected text or relayed content.
		if (event.source === "extension" || event.text.trimStart().startsWith("/")) return { action: "continue" };
		if (!KEYWORD_RE.test(event.text)) return { action: "continue" };
		turnIsUltracode = true;
		syncTicker();
		return { action: "transform", text: event.text + keywordNote(size()), images: event.images };
	});

	pi.on("before_agent_start", (event, ctx) => {
		ctxRef = ctx;
		refreshDetached(ctx);
		const extra: string[] = [];
		if (modeOn) extra.push(ultracodeSystemPrompt(size()));
		const saved = [...discoverSaved(ctx.cwd).values()];
		if (saved.length) {
			extra.push(
				`\n# Saved workflows\nRun with the workflow tool ({ name, args }):\n${saved
					.map((w) => `- ${w.name}${w.description ? `: ${w.description}` : ""}`)
					.join("\n")}`,
			);
		}
		const interrupted = detached.filter((d) => d.state === "interrupted");
		if (interrupted.length) {
			extra.push(
				`\n# Interrupted workflow runs\nThese runs from this session are NOT running: the pi process that ran them exited before they finished, so no result will arrive. To continue one, call the workflow tool with { resume: "<id>" } (finished agents are reused, the rest run again).\n${interrupted
					.map((d) => `- ${d.run.id} (${d.run.name}): ${d.run.done}/${d.run.total} agents finished`)
					.join("\n")}`,
			);
		}
		if (extra.length) event.systemPromptOptions.appendSystemPrompt = `${event.systemPromptOptions.appendSystemPrompt ?? ""}\n${extra.join("\n")}`;
		return undefined;
	});

	pi.on("agent_end", (_event, ctx) => {
		turnIsUltracode = false;
		if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
		syncTicker();
	});

	pi.on("session_shutdown", () => {
		// Quitting pi interrupts running workflows; they show up as resumable when the session is resumed.
		for (const r of runs) if (r.running) r.stop("shutdown");
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		editor?.dispose();
	});
}
