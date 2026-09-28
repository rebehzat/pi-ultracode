/**
 * Runs one workflow agent as a child `pi` process in JSON mode.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const DEPTH_ENV = "PI_ULTRACODE_DEPTH";

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });

export function addUsage(into: Usage, from: Usage): void {
	into.input += from.input;
	into.output += from.output;
	into.cacheRead += from.cacheRead;
	into.cacheWrite += from.cacheWrite;
	into.cost += from.cost;
	into.turns += from.turns;
}

export interface SpawnOptions {
	prompt: string;
	cwd: string;
	sessionDir: string;
	/** Continue the most recent session in sessionDir instead of starting fresh. */
	continueSession?: boolean;
	model?: string;
	thinking?: string;
	tools?: string[];
	systemPrompt?: string;
	signal: AbortSignal;
	onToolCall?: (summary: string) => void;
	onUsage?: (usage: Usage) => void;
}

export interface SpawnResult {
	text: string;
	usage: Usage;
	exitCode: number;
	stopReason?: string;
	error?: string;
	model?: string;
	aborted: boolean;
	/** The child already exhausted Pi's built-in automatic retries. */
	retryExhausted?: boolean;
}

const MAX_INLINE_PROMPT = 100_000;

/** Retrying these failures in a new process cannot repair the task. */
export function isPermanentError(error?: string): boolean {
	return !!error && /\b(?:401|403)\b|unauthorized|invalid[_ -]api[_ -]key|no api key|authentication (?:failed|required)|model .{0,80}(?:not found|does not exist)|unknown (?:model|provider)|insufficient[_ -]quota|billing hard limit/i.test(error);
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/") && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const exe = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exe)) return { command: process.execPath, args };
	return { command: "pi", args };
}

export function summarizeToolCall(name: string, args: Record<string, any> = {}): string {
	const pick = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.url ?? args.query;
	const detail = typeof pick === "string" ? pick : JSON.stringify(args);
	const oneLine = detail.replace(/\s+/g, " ");
	return `${name} ${oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine}`;
}

export async function runPiAgent(opts: SpawnOptions): Promise<SpawnResult> {
	fs.mkdirSync(opts.sessionDir, { recursive: true });
	// The workflow owns fan-out. Recursive orchestration adds serial waits and bypasses
	// its concurrency cap (and can mutate the parent's shared subagent registry).
	const args = ["--mode", "json", "-p", "--session-dir", opts.sessionDir,
		"--exclude-tools", "spawn_agent,send_message,followup_task,wait_agent,list_agents,kill_agent,workflow,workflow_manage"];
	if (opts.continueSession) args.push("--continue");
	if (opts.model) args.push("--model", opts.model);
	if (opts.thinking) args.push("--thinking", opts.thinking);
	if (opts.tools) args.push(...(opts.tools.length ? ["--tools", opts.tools.join(",")] : ["--no-tools"]));
	if (opts.systemPrompt?.trim()) {
		const file = path.join(opts.sessionDir, "system-prompt.md");
		fs.writeFileSync(file, opts.systemPrompt, { mode: 0o600 });
		args.push("--append-system-prompt", file);
	}
	if (Buffer.byteLength(opts.prompt) > MAX_INLINE_PROMPT) {
		const file = path.join(opts.sessionDir, `prompt-${Date.now()}.md`);
		fs.writeFileSync(file, opts.prompt, { mode: 0o600 });
		args.push(`@${file}`, "Carry out the task described in the attached file.");
	} else {
		// A leading "@" would be read as a file attachment.
		args.push("--", opts.prompt.startsWith("@") ? ` ${opts.prompt}` : opts.prompt);
	}

	const result: SpawnResult = { text: "", usage: emptyUsage(), exitCode: 0, aborted: false };
	if (opts.signal.aborted) return { ...result, aborted: true, exitCode: 1 };

	return new Promise((resolve) => {
		const inv = piInvocation(args);
		const depth = Number(process.env[DEPTH_ENV] ?? 0) + 1;
		const proc = spawn(inv.command, inv.args, {
			cwd: opts.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, [DEPTH_ENV]: String(depth) },
		});
		let fragments: string[] = [];
		let stderr = "";
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		// Decode split UTF-8 characters correctly instead of corrupting JSON/text.
		proc.stdout.setEncoding("utf8");
		proc.stderr.setEncoding("utf8");

		const onLine = (line: string) => {
			if (!line.trim()) return;
			// Pi's JSONL events put type first. Discard deltas/tool payloads before JSON
			// parsing; message_end is authoritative. Unknown layouts still use the parser.
			const type = /^\s*\{\s*"type"\s*:\s*"([^"]+)"/.exec(line)?.[1];
			if (type && !["message_end", "auto_retry_start", "auto_retry_end"].includes(type)) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "auto_retry_start") {
				opts.onToolCall?.(`API retry ${event.attempt}/${event.maxAttempts} · waiting ${event.delayMs}ms`);
				return;
			}
			if (event.type === "auto_retry_end") {
				result.retryExhausted = event.success === false;
				return;
			}
			if (event.type !== "message_end" || event.message?.role !== "assistant") return;
			const msg = event.message;
			result.usage.turns++;
			const u = msg.usage;
			if (u) {
				result.usage.input += u.input || 0;
				result.usage.output += u.output || 0;
				result.usage.cacheRead += u.cacheRead || 0;
				result.usage.cacheWrite += u.cacheWrite || 0;
				result.usage.cost += u.cost?.total || 0;
			}
			opts.onUsage?.(result.usage);
			if (msg.model) result.model = msg.model;
			if (msg.stopReason) result.stopReason = msg.stopReason;
			result.error = msg.errorMessage;
			if (msg.stopReason !== "error" && msg.stopReason !== "aborted") result.retryExhausted = false;
			const texts: string[] = [];
			for (const part of msg.content ?? []) {
				if (part.type === "text") texts.push(part.text);
				else if (part.type === "toolCall") opts.onToolCall?.(summarizeToolCall(part.name, part.arguments));
			}
			if (texts.length) result.text = texts.join("\n");
		};

		proc.stdout.on("data", (chunk: string) => {
			let start = 0;
			let end: number;
			while ((end = chunk.indexOf("\n", start)) !== -1) {
				const part = chunk.slice(start, end);
				if (fragments.length) {
					fragments.push(part);
					onLine(fragments.join(""));
					fragments = [];
				} else onLine(part);
				start = end + 1;
			}
			if (start < chunk.length) fragments.push(chunk.slice(start));
		});
		proc.stderr.on("data", (d) => {
			stderr += d.toString();
			if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
		});

		const kill = () => {
			result.aborted = true;
			proc.kill("SIGTERM");
			killTimer = setTimeout(() => proc.exitCode === null && proc.signalCode === null && proc.kill("SIGKILL"), 5000);
			killTimer.unref();
		};
		opts.signal.addEventListener("abort", kill, { once: true });
		if (opts.signal.aborted) kill();

		proc.on("close", (code) => {
			opts.signal.removeEventListener("abort", kill);
			if (killTimer) clearTimeout(killTimer);
			if (fragments.length) onLine(fragments.join(""));
			result.exitCode = code ?? 1;
			if (result.exitCode !== 0 && !result.error) result.error = stderr.trim().slice(-2000) || `pi exited with code ${code}`;
			resolve(result);
		});
		proc.on("error", (err) => {
			opts.signal.removeEventListener("abort", kill);
			if (killTimer) clearTimeout(killTimer);
			result.exitCode = 1;
			result.error = err.message;
			resolve(result);
		});
	});
}
