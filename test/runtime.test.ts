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

console.log("ok");
