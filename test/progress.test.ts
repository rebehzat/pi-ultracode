import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emptyUsage, type SpawnOptions, type SpawnResult } from "../extensions/ultracode/agent.ts";
import { observeProgress } from "../extensions/ultracode/progress.ts";
import { parseScript, WorkflowRun } from "../extensions/ultracode/runtime.ts";

process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-progress-"));
const records: any[] = [];
let session: string | undefined = "session-one";
const pi = { appendEntry: (customType: string, data: any) => records.push({ type: "custom", customType, data }) };
const deferred = () => {
	let resolve!: (r: SpawnResult) => void;
	const promise = new Promise<SpawnResult>((r) => { resolve = r; });
	return { promise, resolve };
};
const ok = (input = 2): SpawnResult => ({ text: "private child result", usage: { ...emptyUsage(), input, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.125 }, exitCode: 0, aborted: false });
const first = deferred();
let entered!: () => void;
const started = new Promise<void>((r) => { entered = r; });
const source = `export const meta = { name: 'secret/path', phases: ['secret phase', 'second private phase'], description: 'secret description' }
phase('secret phase')
await agent('secret prompt', { label: 'secret label' })
phase('second private phase')
return await agent('second secret prompt')`;
const run = new WorkflowRun(source, parseScript(source), undefined,
	{ cwd: process.cwd(), sessionId: "session-one", maxConcurrent: 1, maxStructuredRetries: 1,
		runAgent: async (o: SpawnOptions) => {
			if (o.prompt === "secret prompt") { entered(); return first.promise; }
			return ok(7);
		} });
const emit = observeProgress(pi, run, "session-one", () => session);
run.onTransition(emit);
emit({ type: "launch" });
const done = run.start();
await started;
run.pause();
run.resume();
// Stream activity / usage may update the widget, but must not append progress records.
const count = records.length;
run.agents[0]!.activity.push("private tool /path");
assert.equal(records.length, count);
first.resolve(ok());
await done;
const entries = records.map((e) => e.data);
assert.deepEqual(records.map((e) => [e.type, e.customType]), records.map(() => ["custom", "piano-task-progress"]));
assert.deepEqual(entries.map((e) => [e.kind, e.status, e.phaseIndex]), [
	["workflow_run", "running", undefined], ["workflow_run", "running", 0],
	["workflow_member", "running", 0], ["workflow_run", "waiting", 0],
	["workflow_run", "running", 0], ["workflow_member", "completed", 0],
	["workflow_run", "running", undefined], ["workflow_run", "running", 1],
	["workflow_member", "running", 1], ["workflow_member", "completed", 1],
	["workflow_run", "completed", undefined], ["workflow_run", "completed", 1],
]);
assert.equal(entries.at(-1).usage.totalTokens, 2 + 3 + 4 + 5 + 7 + 3 + 4 + 5);
assert.equal(entries.at(-1).usage.costUsd, 0.25);
assert.equal(entries.at(-1).endedAt, new Date(run.endedAt!).toISOString());
assert.equal(entries[0].runId, entries[0].taskId);
assert.equal(new Set(entries.filter((e) => e.kind === "workflow_member").map((e) => e.taskId)).size, 2);
assert.equal(entries.find((e) => e.agentIndex === 0).title, "Agent #1");
assert.deepEqual(entries[0].phases, [{ index: 0, title: "Phase #1" }, { index: 1, title: "Phase #2" }]);
assert.deepEqual(entries.filter((e) => e.kind === "workflow_member").map((e) => e.phaseIndex), [0, 0, 1, 1]);
for (const e of entries) {
	assert.equal(e.version, 1);
	assert.equal(e.sessionId, "session-one");
	assert.match(e.taskId, /^[a-f0-9]{32}$/);
	assert.match(e.runId, /^[a-f0-9]{32}$/);
	assert.ok(Date.parse(e.updatedAt));
	assert.deepEqual(Object.keys(e).sort(), Object.keys(e).filter((k) => [
		"version", "sessionId", "taskId", "kind", "status", "runId", "agentIndex", "workflowName",
		"title", "phaseIndex", "phaseTitle", "phases", "startedAt", "updatedAt", "endedAt", "usage",
	].includes(k)).sort());
	assert.doesNotMatch(JSON.stringify(e), /secret|private|prompt|child|\.js|pid|script|\/path/);
}

// Stopping while a child is active settles the child and then the run; once the
// session switches, even late child completions cannot append into the next session.
const pending = deferred();
const slow = new WorkflowRun("return await agent('private slow')", parseScript("return await agent('private slow')"), undefined,
	{ cwd: process.cwd(), sessionId: "session-one", maxConcurrent: 1, maxStructuredRetries: 1, runAgent: () => pending.promise });
const slowEmit = observeProgress(pi, slow, "session-one", () => session);
slow.onTransition(slowEmit);
slowEmit({ type: "launch" });
const p = slow.start();
await new Promise((r) => setTimeout(r, 10));
slow.stop("shutdown");
assert.equal(records.at(-1).data.status, "interrupted");
const beforeSwitch = records.length;
session = "session-two";
pending.resolve({ ...ok(), aborted: true });
await p;
assert.equal(records.length, beforeSwitch);

// Bound indices rather than persisting non-contract values.
session = "session-one";
{
	const limited = new WorkflowRun("return 1", parseScript("return 1"), undefined,
		{ cwd: process.cwd(), maxConcurrent: 1, maxStructuredRetries: 1 });
	limited.phases = Array.from({ length: 1002 }, (_, i) => `private ${i}`);
	const limitedEmit = observeProgress(pi, limited, "session-one", () => session);
	limitedEmit({ type: "phase_start", index: 1001 });
	assert.equal(records.at(-1).data.phaseIndex, undefined);
	assert.equal(records.at(-1).data.phaseTitle, undefined);
	limitedEmit({ type: "phase_start", index: 31 });
	assert.deepEqual([records.at(-1).data.phaseIndex, records.at(-1).data.phaseTitle], [31, "Phase #32"]);
	assert.equal(records.at(-1).data.phases.length, 32);
	limitedEmit({ type: "phase_start", index: 32 });
	assert.equal(records.at(-1).data.phaseIndex, undefined);
}

// Stop and script errors are distinct terminal states, with no error text leaked.
session = "session-one";
{
	const stopPending = deferred();
	const stopRun = new WorkflowRun("return await agent('private stop')", parseScript("return await agent('private stop')"), undefined,
		{ cwd: process.cwd(), maxConcurrent: 1, maxStructuredRetries: 1, runAgent: () => stopPending.promise });
	const stopEmit = observeProgress(pi, stopRun, "session-one", () => session);
	stopRun.onTransition(stopEmit);
	stopEmit({ type: "launch" });
	const stopDone = stopRun.start();
	await new Promise((r) => setTimeout(r, 10));
	stopRun.stop();
	stopPending.resolve({ ...ok(), aborted: true });
	await stopDone;
	assert.deepEqual(records.slice(-3).map((e) => e.data.status), ["cancelled", "cancelled", "cancelled"]);
	const fail = new WorkflowRun("throw Error('private failure')", parseScript("throw Error('private failure')"), undefined,
		{ cwd: process.cwd(), maxConcurrent: 1, maxStructuredRetries: 1 });
	const failEmit = observeProgress(pi, fail, "session-one", () => session);
	fail.onTransition(failEmit);
	failEmit({ type: "launch" });
	await fail.start();
	assert.equal(records.at(-1).data.status, "failed");
	assert.doesNotMatch(JSON.stringify(records.at(-1)), /private failure/);
}

// The extension connects launch to Pi without needing a UI or /ultracode mode.
{
	const handlers = new Map<string, (...args: any[]) => any>();
	let tool: any;
	const received: any[] = [];
	const api: any = { on: (name: string, fn: any) => handlers.set(name, fn), registerTool: (t: any) => { if (t.name === "workflow") tool = t; },
		registerCommand: () => {}, registerMessageRenderer: () => {}, appendEntry: (kind: string, data: any) => received.push([kind, data]),
		getThinkingLevel: () => "medium" };
	const ctx: any = { mode: "json", cwd: process.cwd(), hasUI: false,
		sessionManager: { getSessionId: () => "session-three", getBranch: () => [] }, ui: { setWorkingMessage: () => {} } };
	const { default: extension } = await import("../extensions/ultracode/index.ts");
	const depth = process.env.PI_ULTRACODE_DEPTH;
	delete process.env.PI_ULTRACODE_DEPTH;
	try { extension(api); } finally { if (depth !== undefined) process.env.PI_ULTRACODE_DEPTH = depth; }
	handlers.get("session_start")!({ reason: "new" }, ctx);
	await tool.execute("id", { script: "return 1" }, undefined, undefined, ctx);
	assert.deepEqual(received.map(([kind, data]) => [kind, data.status]), [
		["piano-task-progress", "running"], ["piano-task-progress", "completed"]]);
	assert.equal(received[0][1].taskId, received[1][1].taskId);
}
console.log("ok: transition records, privacy, usage, session pinning, extension wiring");
