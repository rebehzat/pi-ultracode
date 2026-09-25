/**
 * On-disk view of workflow runs, so runs survive the pi process that started them:
 * a run whose owner process is gone shows up as "interrupted" and can be resumed
 * (finished agents replay from the journal).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runsRoot } from "./runtime.ts";

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
	const result = readJson(path.join(dir, "result.json"));
	let total = 0;
	try {
		total = fs.readdirSync(path.join(dir, "agents")).length;
	} catch {}
	const done = countLines(path.join(dir, "journal.jsonl"));
	let startedAt = 0;
	try {
		startedAt = fs.statSync(path.join(dir, "script.js")).mtimeMs;
	} catch {}
	return {
		id,
		name: state?.name ?? result?.name ?? id.replace(/-[0-9a-f]{6}$/, ""),
		description: state?.description,
		sessionId: state?.sessionId,
		cwd: state?.cwd,
		pid: state?.pid,
		// A result file means the run ended; otherwise trust run.json; legacy runs without either never finished.
		status: result?.status ?? state?.status ?? "running",
		startedAt: state?.startedAt ?? startedAt,
		endedAt: state?.endedAt,
		done,
		total: Math.max(total, done),
		resumedBy: state?.resumedBy,
		dismissed: state?.dismissed,
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
