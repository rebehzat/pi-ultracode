/**
 * Workflow runtime: executes a workflow script in a vm context with the
 * agent / parallel / pipeline / phase / log primitives, journals each agent's
 * result so a relaunch can replay finished work, and tracks progress for the UI.
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { addUsage, emptyUsage, runPiAgent, type Usage } from "./agent.ts";
import { extractJson, findContradiction, validate, type JsonSchema } from "./schema.ts";

export const MAX_AGENTS_PER_RUN = 1000;
export const MAX_ITEMS_PER_CALL = 4096;

export type AgentStatus = "queued" | "running" | "done" | "cached" | "failed" | "stopped";
/** "interrupted": stopped because pi exited; resumable, and shown as such when the session is resumed. */
export type RunStatus = "running" | "paused" | "done" | "failed" | "stopped" | "interrupted";

export interface AgentOptions {
	label?: string;
	schema?: JsonSchema;
	model?: string;
	thinking?: string;
	tools?: string[];
	cwd?: string;
	systemPrompt?: string;
}

export interface AgentState {
	index: number;
	label: string;
	phase?: string;
	prompt: string;
	options: AgentOptions;
	status: AgentStatus;
	model?: string;
	startedAt?: number;
	endedAt?: number;
	usage: Usage;
	activity: string[];
	result?: unknown;
	error?: string;
	controller: AbortController;
	restart?: boolean;
}

export interface WorkflowMeta {
	name: string;
	description?: string;
	phases?: string[];
}

export interface ParsedScript {
	meta: WorkflowMeta;
	body: string;
	/** Source range of the whole `export const meta = {...}` statement, if present. */
	metaRange?: [number, number];
}

interface JournalEntry {
	key: string;
	result: unknown;
	usage: Usage;
}

export interface RunDefaults {
	cwd: string;
	/** pi session that launched the run, recorded in run.json so a resumed session can find it again. */
	sessionId?: string;
	model?: string;
	thinking?: string;
	maxConcurrent: number;
	maxStructuredRetries: number;
	/** Agent runner; tests inject a stub. */
	runAgent?: typeof runPiAgent;
}

export function runsRoot(): string {
	return path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "ultracode", "runs");
}

/** Find the object literal after `export const meta =` and evaluate it (literals only). */
export function parseScript(source: string, fallbackName = "workflow"): ParsedScript {
	if (/\bimport\s*\(/.test(source) || /^\s*import\s/m.test(source)) {
		throw new Error("Workflow scripts cannot load modules (import). Put work that needs a library in an agent's task.");
	}
	if (/\brequire\s*\(/.test(source)) throw new Error("Workflow scripts cannot call require().");

	let meta: WorkflowMeta = { name: fallbackName };
	let body = source;
	let metaRange: [number, number] | undefined;
	const m = /export\s+const\s+meta\s*=\s*/.exec(source);
	if (m) {
		const start = m.index + m[0].length;
		const end = matchBrace(source, start);
		if (end < 0) throw new Error("Could not parse `export const meta = {...}`: unbalanced braces.");
		const literal = source.slice(start, end + 1);
		try {
			meta = vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 100 });
		} catch (e) {
			throw new Error(`\`meta\` must be a plain object literal: ${(e as Error).message}`);
		}
		if (!meta || typeof meta.name !== "string") throw new Error("`meta.name` must be a string.");
		body = `${source.slice(0, m.index)}const meta = ${source.slice(start)}`;
		metaRange = [m.index, end + 1];
	}
	if (/^\s*export\s/m.test(body)) throw new Error("Only `export const meta` may be exported from a workflow script.");
	return { meta, body, metaRange };
}

/** Rewrite the script's meta block (used when saving under a different name). */
export function withMeta(source: string, meta: WorkflowMeta): string {
	const { metaRange } = parseScript(source);
	const block = `export const meta = ${JSON.stringify(meta, null, 2)}`;
	return metaRange ? source.slice(0, metaRange[0]) + block + source.slice(metaRange[1]) : `${block}\n\n${source}`;
}

function matchBrace(src: string, start: number): number {
	if (src[start] !== "{") return -1;
	let depth = 0;
	let quote: string | null = null;
	for (let i = start; i < src.length; i++) {
		const c = src[i]!;
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") quote = c;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return i;
	}
	return -1;
}

const PRELUDE = `
"use strict";
Math.random = () => { throw new Error("Math.random() is disabled in workflow scripts so a relaunch replays the same agent() calls. Pass randomness in through args."); };
(() => {
  const RealDate = Date;
  function WorkflowDate(...a) {
    if (!new.target) throw new Error("Date() is disabled in workflow scripts. Pass a timestamp in through args.");
    if (a.length === 0) throw new Error("new Date() without arguments is disabled in workflow scripts. Pass a timestamp in through args.");
    return new RealDate(...a);
  }
  WorkflowDate.prototype = RealDate.prototype;
  WorkflowDate.UTC = RealDate.UTC;
  WorkflowDate.parse = RealDate.parse;
  WorkflowDate.now = () => { throw new Error("Date.now() is disabled in workflow scripts. Pass a timestamp in through args."); };
  globalThis.Date = WorkflowDate;
})();
globalThis.args = __argsJson === undefined ? undefined : JSON.parse(__argsJson);
`;

class Gate {
	active = 0;
	paused = false;
	private waiters: (() => void)[] = [];
	limit: number;
	constructor(limit: number) {
		this.limit = limit;
	}

	async acquire(signal: AbortSignal): Promise<void> {
		while (this.paused || this.active >= this.limit) {
			if (signal.aborted) throw new Error("aborted");
			await new Promise<void>((r) => this.waiters.push(r));
		}
		if (signal.aborted) throw new Error("aborted");
		this.active++;
	}

	release(): void {
		this.active--;
		this.wake();
	}

	wake(): void {
		const w = this.waiters;
		this.waiters = [];
		w.forEach((f) => f());
	}
}

function hashKey(prompt: string, opts: AgentOptions): string {
	const { label: _label, ...rest } = opts;
	return createHash("sha256").update(prompt).update("\0").update(JSON.stringify(rest)).digest("hex").slice(0, 32);
}

export class WorkflowRun {
	readonly id: string;
	readonly runDir: string;
	readonly scriptPath: string;
	readonly meta: WorkflowMeta;
	status: RunStatus = "running";
	agents: AgentState[] = [];
	phases: string[] = [];
	currentPhase?: string;
	logs: string[] = [];
	startedAt = Date.now();
	endedAt?: number;
	result?: unknown;
	error?: string;
	readonly usage = emptyUsage();

	private readonly controller = new AbortController();
	private readonly gate: Gate;
	private readonly replay = new Map<string, JournalEntry[]>();
	private readonly journalPath: string;
	private listeners = new Set<() => void>();
	private promise?: Promise<void>;

	readonly source: string;
	private readonly parsed: ParsedScript;
	private readonly args: unknown;
	private readonly defaults: RunDefaults;

	constructor(source: string, parsed: ParsedScript, args: unknown, defaults: RunDefaults, resumeFrom?: string) {
		this.source = source;
		this.parsed = parsed;
		this.args = args;
		this.defaults = defaults;
		this.id = `${parsed.meta.name.replace(/[^\w.-]+/g, "-").slice(0, 40)}-${randomBytes(3).toString("hex")}`;
		this.meta = parsed.meta;
		this.phases = [...(parsed.meta.phases ?? [])];
		this.runDir = path.join(runsRoot(), this.id);
		fs.mkdirSync(this.runDir, { recursive: true });
		this.scriptPath = path.join(this.runDir, "script.js");
		this.journalPath = path.join(this.runDir, "journal.jsonl");
		fs.writeFileSync(this.scriptPath, source);
		fs.writeFileSync(path.join(this.runDir, "args.json"), JSON.stringify(args ?? null, null, 2));
		this.gate = new Gate(defaults.maxConcurrent);
		this.controller.signal.addEventListener("abort", () => this.gate.wake());
		this.resumedFrom = resumeFrom;
		if (resumeFrom) this.loadJournal(resumeFrom);
		this.writeState();
	}

	private loadJournal(runId: string): void {
		const file = path.join(runsRoot(), runId, "journal.jsonl");
		if (!fs.existsSync(file)) throw new Error(`nothing to resume: no journal for run ${runId}`);
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as JournalEntry;
				const list = this.replay.get(entry.key) ?? [];
				list.push(entry);
				this.replay.set(entry.key, list);
			} catch {}
		}
	}

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private lastStateWrite = 0;
	readonly resumedFrom?: string;

	/**
	 * run.json: who owns this run (pid, session) and its current status. Written synchronously so the
	 * status on disk is honest even if pi exits right after (a run whose owner died reads as interrupted).
	 */
	writeState(): void {
		this.lastStateWrite = Date.now();
		const record = {
			id: this.id,
			name: this.meta.name,
			description: this.meta.description,
			sessionId: this.defaults.sessionId,
			cwd: this.defaults.cwd,
			pid: process.pid,
			status: this.status,
			startedAt: this.startedAt,
			endedAt: this.endedAt,
			agents: this.counts(),
			resumedFrom: this.resumedFrom,
		};
		try {
			fs.writeFileSync(path.join(this.runDir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
		} catch {}
	}

	private changed(): void {
		if (Date.now() - this.lastStateWrite > 5000) this.writeState();
		for (const fn of this.listeners) {
			try {
				fn();
			} catch {}
		}
	}

	start(): Promise<void> {
		this.promise ??= this.execute();
		return this.promise;
	}

	pause(): void {
		if (this.status !== "running") return;
		this.gate.paused = true;
		this.status = "paused";
		this.writeState();
		this.changed();
	}

	resume(): void {
		if (this.status !== "paused") return;
		this.gate.paused = false;
		this.status = "running";
		this.writeState();
		this.gate.wake();
		this.changed();
	}

	stop(reason: "user" | "shutdown" = "user"): void {
		if (this.endedAt) return;
		this.status = reason === "shutdown" ? "interrupted" : "stopped";
		this.writeState();
		this.controller.abort();
		this.changed();
	}

	stopAgent(index: number): void {
		this.agents[index]?.controller.abort();
	}

	restartAgent(index: number): void {
		const a = this.agents[index];
		if (!a || a.status !== "running") return;
		a.restart = true;
		a.controller.abort();
	}

	get running(): boolean {
		return !this.endedAt;
	}

	counts(): { done: number; running: number; failed: number; total: number } {
		let done = 0;
		let running = 0;
		let failed = 0;
		for (const a of this.agents) {
			if (a.status === "done" || a.status === "cached") done++;
			else if (a.status === "running") running++;
			else if (a.status === "failed" || a.status === "stopped") failed++;
		}
		return { done, running, failed, total: this.agents.length };
	}

	private log(...parts: unknown[]): void {
		const text = parts.map((p) => (typeof p === "string" ? p : safeStringify(p))).join(" ");
		this.logs.push(text);
		if (this.logs.length > 200) this.logs.shift();
		this.changed();
	}

	private phase(title: unknown): void {
		const t = String(title);
		this.currentPhase = t;
		if (!this.phases.includes(t)) this.phases.push(t);
		this.changed();
	}

	private async agent(prompt: unknown, rawOpts: unknown = {}): Promise<unknown> {
		if (typeof prompt !== "string" || !prompt.trim()) throw new TypeError("agent(prompt) needs a non-empty string prompt");
		if (this.agents.length >= MAX_AGENTS_PER_RUN) throw new Error(`workflow exceeded ${MAX_AGENTS_PER_RUN} agents`);
		const opts = (rawOpts && typeof rawOpts === "object" ? JSON.parse(JSON.stringify(rawOpts)) : {}) as AgentOptions;
		if (opts.schema) {
			const contradiction = findContradiction(opts.schema);
			if (contradiction) throw new Error(`agent schema contradicts itself: ${contradiction}`);
		}

		const state: AgentState = {
			index: this.agents.length,
			label: opts.label ?? prompt.replace(/\s+/g, " ").slice(0, 60),
			phase: this.currentPhase,
			prompt,
			options: opts,
			status: "queued",
			usage: emptyUsage(),
			activity: [],
			controller: new AbortController(),
		};
		this.agents.push(state);
		this.changed();

		const key = hashKey(prompt, opts);
		const cached = this.replay.get(key)?.shift();
		if (cached) {
			state.status = "cached";
			state.result = cached.result;
			state.usage = cached.usage;
			this.appendJournal(cached);
			this.changed();
			return cached.result;
		}

		try {
			await this.gate.acquire(this.controller.signal);
		} catch {
			state.status = "stopped";
			this.changed();
			return null;
		}
		try {
			return await this.runAgent(state, key);
		} finally {
			this.gate.release();
		}
	}

	private async runAgent(state: AgentState, key: string): Promise<unknown> {
		const opts = state.options;
		const onRunAbort = () => state.controller.abort();
		this.controller.signal.addEventListener("abort", onRunAbort, { once: true });
		try {
			while (true) {
				state.status = "running";
				state.startedAt = Date.now();
				state.endedAt = undefined;
				state.usage = emptyUsage();
				state.activity = [];
				this.changed();

				const outcome = await this.attempt(state);
				if (state.restart && !this.controller.signal.aborted) {
					state.restart = false;
					state.controller = new AbortController();
					continue;
				}
				state.endedAt = Date.now();
				if (outcome.kind === "stopped") {
					state.status = "stopped";
					this.changed();
					return null;
				}
				if (outcome.kind === "error") {
					state.status = "failed";
					state.error = outcome.error;
					this.changed();
					if (outcome.throws) throw new Error(`agent "${state.label}": ${outcome.error}`);
					return null;
				}
				state.status = "done";
				state.result = outcome.value;
				this.appendJournal({ key, result: outcome.value, usage: state.usage });
				this.changed();
				return outcome.value;
			}
		} finally {
			this.controller.signal.removeEventListener("abort", onRunAbort);
		}
	}

	private async attempt(
		state: AgentState,
	): Promise<{ kind: "ok"; value: unknown } | { kind: "stopped" } | { kind: "error"; error: string; throws: boolean }> {
		const opts = state.options;
		const sessionDir = path.join(this.runDir, "agents", String(state.index));
		fs.rmSync(sessionDir, { recursive: true, force: true });
		let prompt = state.prompt;
		if (opts.schema) {
			prompt +=
				"\n\n---\nWhen you are finished, your FINAL message must contain only a JSON value (no prose, no code fence) " +
				`that validates against this JSON Schema:\n${JSON.stringify(opts.schema)}`;
		}
		const maxAttempts = opts.schema ? this.defaults.maxStructuredRetries : 1;
		let continueSession = false;
		let apiRetries = 0;
		for (let attempt = 1; attempt <= maxAttempts; ) {
			const before = { ...state.usage };
			const res = await (this.defaults.runAgent ?? runPiAgent)({
				prompt,
				continueSession,
				cwd: opts.cwd ? path.resolve(this.defaults.cwd, opts.cwd) : this.defaults.cwd,
				sessionDir,
				model: opts.model ?? this.defaults.model,
				thinking: opts.thinking ?? (opts.model ? undefined : this.defaults.thinking),
				tools: opts.tools,
				systemPrompt: opts.systemPrompt,
				signal: state.controller.signal,
				onToolCall: (s) => {
					state.activity.push(s);
					if (state.activity.length > 50) state.activity.shift();
					this.changed();
				},
				onUsage: (u) => {
					state.usage = { ...before };
					addUsage(state.usage, u);
					this.changed();
				},
			});
			state.usage = { ...before };
			addUsage(state.usage, res.usage);
			addUsage(this.usage, res.usage);
			if (res.model) state.model = res.model;
			if (res.aborted || state.controller.signal.aborted) return { kind: "stopped" };
			if (res.exitCode !== 0 || res.stopReason === "error") {
				// One retry for transient API/process failures, then give up (resolves null).
				if (apiRetries++ < 1) {
					continueSession = false;
					fs.rmSync(sessionDir, { recursive: true, force: true });
					continue;
				}
				return { kind: "error", error: res.error ?? "agent failed", throws: false };
			}
			if (!opts.schema) return { kind: "ok", value: res.text };

			const parsed = extractJson(res.text);
			const problems = parsed.ok ? validate(opts.schema, parsed.value) : [parsed.error];
			if (parsed.ok && problems.length === 0) return { kind: "ok", value: parsed.value };
			if (attempt === maxAttempts) {
				return {
					kind: "error",
					error: `output failed schema validation after ${maxAttempts} attempts: ${problems.slice(0, 5).join("; ")}`,
					throws: true,
				};
			}
			attempt++;
			continueSession = true;
			prompt =
				`Your final message did not match the required JSON Schema:\n- ${problems.slice(0, 10).join("\n- ")}\n\n` +
				`Reply again with ONLY the corrected JSON value, matching:\n${JSON.stringify(opts.schema)}`;
		}
		return { kind: "error", error: "unreachable", throws: false };
	}

	private appendJournal(entry: JournalEntry): void {
		fs.appendFileSync(this.journalPath, `${JSON.stringify(entry)}\n`);
	}

	private async execute(): Promise<void> {
		const settleAll = async (promises: unknown[]): Promise<unknown[]> =>
			Promise.all(
				promises.map((p) =>
					Promise.resolve(p).catch((e) => {
						this.log(`⚠ ${(e as Error)?.message ?? e}`);
						return null;
					}),
				),
			);

		const context = vm.createContext({
			__argsJson: this.args === undefined ? undefined : JSON.stringify(this.args),
			agent: (prompt: unknown, opts?: unknown) => this.agent(prompt, opts),
			parallel: (tasks: unknown) => {
				if (!Array.isArray(tasks)) throw new TypeError("parallel(tasks) expects an array of promises or functions");
				if (tasks.length > MAX_ITEMS_PER_CALL) throw new Error(`parallel() accepts at most ${MAX_ITEMS_PER_CALL} items`);
				return settleAll(tasks.map((t) => (typeof t === "function" ? Promise.resolve().then(() => t()) : t)));
			},
			pipeline: (items: unknown, fn: unknown) => {
				if (!Array.isArray(items)) throw new TypeError("pipeline(items, fn) expects an array");
				if (typeof fn !== "function") throw new TypeError("pipeline(items, fn) expects a function");
				if (items.length > MAX_ITEMS_PER_CALL) throw new Error(`pipeline() accepts at most ${MAX_ITEMS_PER_CALL} items`);
				return settleAll(items.map((item, i) => Promise.resolve().then(() => fn(item, i))));
			},
			phase: (title: unknown) => this.phase(title),
			log: (...parts: unknown[]) => this.log(...parts),
			console: {
				log: (...p: unknown[]) => this.log(...p),
				info: (...p: unknown[]) => this.log(...p),
				warn: (...p: unknown[]) => this.log(...p),
				error: (...p: unknown[]) => this.log(...p),
			},
		});
		try {
			vm.runInContext(PRELUDE, context);
			const wrapped = `"use strict";(async () => {\n${this.parsed.body}\n})()`;
			const script = new vm.Script(wrapped, { filename: this.scriptPath, lineOffset: -1 });
			const value = await script.runInContext(context);
			this.result = value === undefined ? null : JSON.parse(safeStringify(value));
			if (this.status === "running" || this.status === "paused") this.status = "done";
		} catch (e) {
			if (this.status === "running" || this.status === "paused") {
				this.status = "failed";
				this.error = (e as Error)?.stack ?? String(e);
			}
		} finally {
			this.endedAt = Date.now();
			fs.writeFileSync(path.join(this.runDir, "result.json"), safeStringify(this.summary(true), 2));
			this.writeState();
			this.changed();
		}
	}

	summary(full = false): Record<string, unknown> {
		return {
			id: this.id,
			name: this.meta.name,
			status: this.status,
			script: this.scriptPath,
			startedAt: new Date(this.startedAt).toISOString(),
			durationMs: (this.endedAt ?? Date.now()) - this.startedAt,
			agents: this.counts(),
			usage: this.usage,
			error: this.error,
			logs: full ? this.logs : this.logs.slice(-20),
			result: this.result,
		};
	}
}

export function safeStringify(value: unknown, indent?: number): string {
	const seen = new WeakSet();
	return (
		JSON.stringify(
			value,
			(_k, v) => {
				if (typeof v === "bigint") return v.toString();
				if (v && typeof v === "object") {
					if (seen.has(v)) return "[Circular]";
					seen.add(v);
				}
				return v;
			},
			indent,
		) ?? "null"
	);
}
