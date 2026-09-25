import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emptyUsage, type SpawnOptions, type SpawnResult } from "../extensions/ultracode/agent.ts";
import { parseScript, runsRoot, withMeta, WorkflowRun } from "../extensions/ultracode/runtime.ts";

process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-test-"));

let calls = 0;
const stub = async (o: SpawnOptions): Promise<SpawnResult> => {
	calls++;
	const usage = { ...emptyUsage(), input: 10, output: 5, turns: 1 };
	const ok = (text: string): SpawnResult => ({ text, usage, exitCode: 0, aborted: false });
	if (o.prompt.startsWith("LIST")) return ok('```json\n{"files":["a.ts","b.ts","c.ts"]}\n```');
	if (o.continueSession) return ok('{"n": 3}');
	if (o.prompt.startsWith("BAD")) return ok('{"n": "three"}');
	if (o.prompt.startsWith("FAIL")) return { text: "", usage, exitCode: 1, error: "boom", aborted: false };
	if (o.prompt.startsWith("SLOW"))
		return new Promise((r) => o.signal.addEventListener("abort", () => r({ ...ok(""), aborted: true })));
	return ok(`done: ${o.prompt}`);
};
const defaults = { cwd: process.cwd(), maxConcurrent: 2, maxStructuredRetries: 3, runAgent: stub };

async function run(src: string, args?: unknown, resume?: string) {
	const r = new WorkflowRun(src, parseScript(src), args, defaults, resume);
	await r.start();
	return r;
}

// meta parsing
const src = `export const meta = { name: 'demo', description: 'd', phases: ['One', 'Two'] }
phase('One')
const found = await agent('LIST files', { schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } } })
phase('Two')
const out = await pipeline(found.files, f => agent('AUDIT ' + f, { label: f }))
const fixed = await agent('BAD number', { schema: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } } })
const failed = await agent('FAIL please')
log('prefix', args.prefix)
return { out, fixed, failed, n: out.filter(Boolean).length }`;
assert.equal(parseScript(src).meta.name, "demo");
assert.match(withMeta(src, { name: "renamed" }), /"name": "renamed"/);
assert.throws(() => parseScript("await import('fs')"), /import/);

let r = await run(src, { prefix: "x" });
assert.equal(r.status, "done", r.error);
const res = r.result as any;
assert.deepEqual(res.out, ["done: AUDIT a.ts", "done: AUDIT b.ts", "done: AUDIT c.ts"]);
assert.deepEqual(res.fixed, { n: 3 });
assert.equal(res.failed, null);
assert.equal(r.agents.filter((a) => a.phase === "Two" && a.label.endsWith(".ts")).length, 3);
assert.deepEqual(r.logs, ["prefix x"]);
assert.ok(fs.existsSync(path.join(runsRoot(), r.id, "result.json")));

// resume replays finished agents from the journal
calls = 0;
const r2 = await run(src, { prefix: "x" }, r.id);
assert.equal(r2.status, "done");
assert.equal(r2.agents.filter((a) => a.status === "cached").length, 5);
assert.equal(calls, 2, "only the failed agent (1 call + 1 retry) reruns");

// determinism guards
for (const bad of ["Date.now()", "new Date()", "Math.random()"]) {
	const x = await run(`return ${bad}`);
	assert.equal(x.status, "failed");
	assert.match(x.error!, /disabled/);
}
assert.equal(((await run("return new Date(0).toISOString()")).result), "1970-01-01T00:00:00.000Z");

// schema contradiction
const c = await run(`return await agent('x', { schema: { type: 'object', additionalProperties: false, required: ['a'] } })`);
assert.equal(c.status, "failed");
assert.match(c.error!, /contradicts/);

// stop
const slow = "return await parallel([agent('SLOW 1'), agent('SLOW 2')])";
const s = new WorkflowRun(slow, parseScript(slow), undefined, defaults);
const p = s.start();
await new Promise((res) => setTimeout(res, 50));
s.stop();
await p;
assert.equal(s.status, "stopped");

// run.json ownership + interrupted runs
{
	const { listRuns, readRun, runState, runIdsFromSession, patchRun } = await import("../extensions/ultracode/registry.ts");
	const withSession = { ...defaults, sessionId: "sess-1" };
	const slow2 = "export const meta = { name: 'long' }\nreturn await agent('SLOW 3')";
	const quit = new WorkflowRun(slow2, parseScript(slow2), { q: 1 }, withSession);
	const qp = quit.start();
	await new Promise((res) => setTimeout(res, 50));
	quit.stop("shutdown");
	await qp;
	assert.equal(quit.status, "interrupted", "quitting pi interrupts rather than stops");
	const rec = readRun(quit.id)!;
	assert.equal(rec.sessionId, "sess-1");
	assert.equal(rec.pid, process.pid);
	assert.equal(runState(rec, new Set()), "interrupted");
	assert.equal(runState(rec, new Set([quit.id])), "live");

	// Legacy run dir (no run.json, no result.json): interrupted.
	const legacy = path.join(runsRoot(), "legacy-abc123");
	fs.mkdirSync(path.join(legacy, "agents", "0"), { recursive: true });
	fs.writeFileSync(path.join(legacy, "script.js"), "return 1");
	fs.writeFileSync(path.join(legacy, "journal.jsonl"), '{"key":"k"}\n');
	const lr = readRun("legacy-abc123")!;
	assert.deepEqual([lr.status, lr.done, lr.total, runState(lr, new Set())], ["running", 1, 1, "interrupted"]);

	// Owned by another live process → elsewhere; dead pid → interrupted.
	patchRun("legacy-abc123", { status: "running", pid: process.ppid });
	assert.equal(runState(readRun("legacy-abc123")!, new Set()), "elsewhere");
	patchRun("legacy-abc123", { pid: 2 ** 22 + 12345 });
	assert.equal(runState(readRun("legacy-abc123")!, new Set()), "interrupted");

	// Finished runs are finished; user-stopped runs are not "interrupted".
	assert.equal(runState(readRun(r.id)!, new Set()), "finished");
	assert.equal(runState(readRun(s.id)!, new Set()), "finished");

	// Session attribution for runs without a session id.
	const ids = runIdsFromSession([
		{ type: "message", message: { role: "toolResult", toolName: "workflow", details: { runId: "legacy-abc123" } } },
		{ type: "message", message: { role: "toolResult", toolName: "bash", details: {} } },
	]);
	assert.deepEqual([...ids], ["legacy-abc123"]);
	assert.ok(listRuns().some((x) => x.id === "legacy-abc123"));

	// Deleting runs: guarded ids, never a live run, never one running in another process.
	const { deleteRun } = await import("../extensions/ultracode/registry.ts");
	assert.equal(deleteRun("../etc", new Set()).ok, false);
	assert.equal(deleteRun("nope-000000", new Set()).ok, false);
	assert.equal(deleteRun(quit.id, new Set([quit.id])).ok, false, "live run refused");
	patchRun("legacy-abc123", { pid: process.ppid });
	assert.equal(deleteRun("legacy-abc123", new Set()).ok, false, "run owned by another live pi refused");
	patchRun("legacy-abc123", { status: "interrupted", pid: 2 ** 22 + 12345 });
	assert.deepEqual(deleteRun("legacy-abc123", new Set()), { ok: true });
	assert.equal(readRun("legacy-abc123"), undefined);
	assert.ok(fs.existsSync(runsRoot()), "runs root itself untouched");
}

// Malformed workflow args: chained {"item": [...]} wrappers and JSON-encoded strings.
{
	const { normalizeArgs, sanitizeContext, depth, MAX_ARG_DEPTH } = await import("../extensions/ultracode/args.ts");
	const items = Array.from({ length: 40 }, (_, i) => ({ name: `e${i}` }));
	// Each wrapper holds the next item plus another wrapper, one level deeper per item.
	let chained: any = { item: [items[39]] };
	for (let i = 38; i >= 0; i--) chained = { item: [items[i], chained] };
	const raw = { implement: { item: chained }, audit: { item: { item: ["a", "b"] } }, flat: ["x"], n: 3 };
	assert.ok(depth(raw) > 40);
	assert.deepEqual(normalizeArgs(raw), { implement: items, audit: ["a", "b"], flat: ["x"], n: 3 });
	assert.deepEqual(normalizeArgs(JSON.stringify(JSON.stringify({ a: [1] }))), { a: [1] });
	assert.deepEqual(normalizeArgs({ items: [1], text: "not json {" }), { items: [1], text: "not json {" }, "other keys untouched");

	const call = { type: "toolCall", id: "c1", name: "workflow", arguments: { script_path: "x.js", args: raw } };
	const messages: any[] = [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "ok" }, call] }];
	const out = sanitizeContext(messages)!;
	assert.ok(out, "deep tool call clipped");
	assert.ok(depth(out[1].content[1].arguments) <= MAX_ARG_DEPTH);
	assert.equal(out[1].content[1].arguments.script_path, "x.js");
	assert.equal(messages[1].content[1], call, "original messages not mutated");
	assert.equal(sanitizeContext([{ role: "assistant", content: [{ type: "toolCall", arguments: { a: [1] } }] }]), undefined);
}

console.log("ok");
