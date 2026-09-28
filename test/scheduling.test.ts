import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentThinking, positiveLimit } from "../extensions/ultracode/config.ts";
import { emptyUsage, type SpawnOptions, type SpawnResult } from "../extensions/ultracode/agent.ts";
import { parseScript, WorkflowRun } from "../extensions/ultracode/runtime.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-scheduling-"));
process.env.PI_CODING_AGENT_DIR = root;
const ok = (text = "ok"): SpawnResult => ({ text, usage: emptyUsage(), exitCode: 0, aborted: false });
const defaults = { cwd: root, maxConcurrent: 2, maxStructuredRetries: 3 };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
try {
	for (const level of ["high", "xhigh", "max"]) assert.equal(agentThinking(undefined, level), "medium");
	for (const level of ["off", "minimal", "low", "medium"]) assert.equal(agentThinking(undefined, level), level);
	assert.equal(agentThinking("inherit", "xhigh"), "xhigh");
	assert.equal(agentThinking("high", "low"), "high");
	for (const value of [-1, 0, Infinity, NaN, "bad"]) assert.equal(positiveLimit(value, 3, 10), 3);
	assert.equal(positiveLimit("2.8", 3, 10), 2);
	assert.equal(positiveLimit(999, 3, 10), 10);

	const starts: number[] = [];
	const complete = new Map<number, () => void>();
	let active = 0, peak = 0;
	const source = "return await pipeline(Array.from({length: 30}, (_, i) => i), i => agent(String(i)))";
	const run = new WorkflowRun(source, parseScript(source), undefined, { ...defaults, runAgent: async (opts) => {
		const id = Number(opts.prompt);
		starts.push(id);
		peak = Math.max(peak, ++active);
		await new Promise<void>((resolve) => complete.set(id, resolve));
		active--;
		return ok(opts.prompt);
	} });
	const finished = run.start();
	await tick();
	assert.deepEqual(starts, [0, 1]);
	run.pause();
	run.stopAgent(5);
	await tick();
	assert.equal(run.agents[5]?.status, "stopped", "queued cancellation settles while paused");
	complete.get(0)!(); complete.get(1)!();
	await tick();
	assert.deepEqual(starts, [0, 1], "pause does not dispatch waiting agents");
	run.resume();
	for (let i = 0; i < 100 && run.running; i++) {
		await tick();
		for (const resolve of complete.values()) resolve();
	}
	await finished;
	assert.equal(run.status, "done", run.error);
	assert.equal(peak, 2);
	assert.deepEqual(starts, Array.from({ length: 30 }, (_, i) => i).filter((i) => i !== 5), "FIFO without waking all waiters");
	assert.equal((run.result as unknown[])[5], null);

	for (const failure of [
		{ error: "401 Unauthorized", exitCode: 1 },
		{ error: "503 exhausted", retryExhausted: true, exitCode: 1 },
		{ error: "503 exhausted", retryExhausted: true, exitCode: 0 },
	]) {
		let calls = 0;
		const src = "return await agent('FAIL')";
		const failed = new WorkflowRun(src, parseScript(src), undefined, { ...defaults, runAgent: async () => {
			calls++;
			return { ...ok(), ...failure };
		} });
		await failed.start();
		assert.equal(calls, 1, "don't repeat a task after permanent/exhausted failure");
		assert.equal(failed.result, null);
	}

	const prompts: SpawnOptions[] = [];
	const schemaSrc = "return await agent('ORIGINAL TASK', { schema: {type:'integer'} })";
	const correction = new WorkflowRun(schemaSrc, parseScript(schemaSrc), undefined, { ...defaults, runAgent: async (opts) => {
		prompts.push(opts);
		if (prompts.length === 1) return ok('"wrong"');
		if (prompts.length === 2) return { ...ok(), exitCode: 1, error: "connection reset" };
		return ok("42");
	} });
	await correction.start();
	assert.equal(correction.result, 42);
	assert.equal(prompts[1]?.continueSession, true);
	assert.equal(prompts[2]?.continueSession, false);
	assert.match(prompts[2]!.prompt, /ORIGINAL TASK/);
	assert.match(prompts[2]!.prompt, /integer/);
	console.log("ok: worker defaults, FIFO concurrency, paused cancellation, bounded retries");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
