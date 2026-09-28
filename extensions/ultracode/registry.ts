/**
 * On-disk view of workflow runs, so runs survive the pi process that started them:
 * a run whose owner process is gone shows up as "interrupted" and can be resumed
 * (finished agents replay from the journal).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runsRoot } from "./runtime.ts";
import { readRunUsage } from "./usage.ts";
import type { Usage } from "./agent.ts";

export type RunState = "live" | "elsewhere" | "interrupted" | "finished";

export interface RunRecord {
	id: string;
	name: string;
	description?: string;
	sessionId?: string;
	cwd?: string;
	pid?: number;
	status: string;
	startedAt: number;
	endedAt?: number;
	/** Finished agents (journal entries) and agents started. */
	done: number;
	total: number;
	resumedBy?: string;
	dismissed?: boolean;
	/** Lazily recomputed from child Pi sessions, including interrupted attempts. */
	usage: Usage;
}

function readJson(file: string): any {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function countLines(file: string): number {
	try {
		return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length;
	} catch {
		return 0;
	}
}

export function pidAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function readRun(id: string): RunRecord | undefined {
	const dir = path.join(runsRoot(), id);
	if (!fs.existsSync(path.join(dir, "script.js"))) return undefined;
	const state = readJson(path.join(dir, "run.json"));
	// Modern runs persist status and agent counts in a small run.json. Reading result.json
	// and the journal for every directory makes session-start and before_agent_start
	// proportional to the size of *all* previous workflows, even unrelated ones.
	// Finalization writes result.json before its final run.json update. A crash in
	// between must not turn a completed run into resumable unfinished work.
	const staleRunning = (state?.status === "running" || state?.status === "paused") && !pidAlive(state?.pid);
	const result = state?.status && state?.name && !staleRunning ? undefined : readJson(path.join(dir, "result.json"));
	const recordedCounts = result?.agents ?? state?.agents;
	const modernCounts = Number.isSafeInteger(recordedCounts?.total) && recordedCounts.total >= 0 &&
		Number.isSafeInteger(recordedCounts?.done) && recordedCounts.done >= 0;
	const status = result?.status ?? state?.status ?? "running";
	// A crashed writer can leave run.json counts up to five seconds behind its
	// journal. Only resolve that journal when the interrupted run's count is used.
	const interrupted = status === "interrupted" || ((status === "running" || status === "paused") && !pidAlive(state?.pid));
	let counts: { done: number; total: number } | undefined;
	const getCounts = () => {
		if (!counts) {
			const done = modernCounts && !interrupted ? recordedCounts.done : countLines(path.join(dir, "journal.jsonl"));
			let total = modernCounts ? recordedCounts.total : 0;
			if (!modernCounts) {
				try { total = fs.readdirSync(path.join(dir, "agents")).length; } catch {}
			}
			counts = { done: Math.max(done, modernCounts ? recordedCounts.done : 0), total: Math.max(total, done) };
		}
		return counts;
	};
	let startedAt = state?.startedAt;
	if (startedAt == null) {
		try {
			startedAt = fs.statSync(path.join(dir, "script.js")).mtimeMs;
		} catch { startedAt = 0; }
	}
	let usage: Usage | undefined;
	return {
		id,
		name: state?.name ?? result?.name ?? id.replace(/-[0-9a-f]{6}$/, ""),
		description: state?.description,
		sessionId: state?.sessionId,
		cwd: state?.cwd,
		pid: state?.pid,
		// Modern metadata is authoritative except for finalization interrupted by a crash.
		status,
		startedAt,
		endedAt: state?.endedAt,
		get done() { return getCounts().done; },
		get total() { return getCounts().total; },
		resumedBy: state?.resumedBy,
		dismissed: state?.dismissed,
		get usage() { return usage ??= readRunUsage(dir).usage; },
	};
}

export function listRuns(): RunRecord[] {
	let ids: string[] = [];
	try {
		ids = fs.readdirSync(runsRoot());
	} catch {
		return [];
	}
	return ids
		.map(readRun)
		.filter((r): r is RunRecord => !!r)
		.sort((a, b) => b.startedAt - a.startedAt);
}

/** Classify a run relative to this process (`liveIds`: runs this process is executing right now). */
export function runState(r: RunRecord, liveIds: Set<string>): RunState {
	if (liveIds.has(r.id)) return "live";
	if (r.status === "interrupted") return "interrupted";
	if (r.status !== "running" && r.status !== "paused") return "finished";
	if (r.pid && r.pid !== process.pid && pidAlive(r.pid)) return "elsewhere";
	return "interrupted";
}

/** Merge fields into a run's run.json (creating it for legacy runs). */
export function patchRun(id: string, patch: Record<string, unknown>): void {
	const file = path.join(runsRoot(), id, "run.json");
	const current = readJson(file) ?? {};
	try {
		fs.writeFileSync(file, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
	} catch {}
}

/** Run ids this session launched through the workflow tool (covers runs from before run.json existed). */
export function runIdsFromSession(entries: any[]): Set<string> {
	const ids = new Set<string>();
	for (const e of entries) {
		const m = e?.type === "message" ? e.message : undefined;
		if (m?.role === "toolResult" && m.toolName === "workflow" && typeof m.details?.runId === "string") ids.add(m.details.runId);
	}
	return ids;
}

/** Interrupted runs that belong to this session and haven't been resumed or dismissed. */
export function interruptedForSession(sessionId: string | undefined, sessionRunIds: Set<string>, liveIds: Set<string>): RunRecord[] {
	return listRuns().filter(
		(r) =>
			!r.resumedBy &&
			!r.dismissed &&
			(r.sessionId ? r.sessionId === sessionId : sessionRunIds.has(r.id)) &&
			runState(r, liveIds) === "interrupted",
	);
}

/** Remove a run directory (script, journal, results, agent sessions). Refuses ids that don't name a run. */
export function deleteRun(id: string, liveIds: Set<string>): { ok: true } | { ok: false; error: string } {
	if (!/^[\w.-]+$/.test(id) || id === "." || id === "..") return { ok: false, error: `invalid run id "${id}"` };
	const dir = path.join(runsRoot(), id);
	if (path.dirname(dir) !== runsRoot() || !fs.existsSync(path.join(dir, "script.js"))) return { ok: false, error: `no workflow run "${id}"` };
	if (liveIds.has(id)) return { ok: false, error: `run ${id} is still running in this pi; stop it first` };
	const rec = readRun(id);
	if (rec && runState(rec, liveIds) === "elsewhere") return { ok: false, error: `run ${id} is running in another pi process (pid ${rec.pid})` };
	fs.rmSync(dir, { recursive: true, force: true });
	return { ok: true };
}
