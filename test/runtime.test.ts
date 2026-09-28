import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emptyUsage, type SpawnOptions, type SpawnResult } from "../extensions/ultracode/agent.ts";
import { parseScript, runsRoot, withMeta, WorkflowRun } from "../extensions/ultracode/runtime.ts";
import { TOOL_DESCRIPTION, ultracodeSystemPrompt, workflowBasics } from "../extensions/ultracode/prompt.ts";
import { readRunUsage } from "../extensions/ultracode/usage.ts";

process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-test-"));

assert.match(workflowBasics, /otherwise handle the task normally/);
assert.doesNotMatch(workflowBasics, /automatic|every substantive|keyword/i);
assert.match(TOOL_DESCRIPTION, /while \/ultracode mode is on/);
assert.doesNotMatch(TOOL_DESCRIPTION, /says ["']?ultracode/);
assert.match(ultracodeSystemPrompt("medium"), /explicitly asks not to launch one/);

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

// Persisted accounting: all agents/attempts/branches and Pi usage categories, not
// duplicated JSON events, cached journal entries or copied fork history.
{
	const entry = (id: string, cost: number, type = "assistant") => type === "assistant"
		? { type: "message", id, message: { role: "assistant", usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: cost } } } }
		: type === "tool" ? { type: "message", id, message: { role: "toolResult", usage: { input: 1, cost: { total: cost } }, details: { usage: { cost: { total: 999 } } } } }
		: { type, id, usage: { output: 1, cost: { total: cost } } };
	const save = (file: string, entries: any[], parentSession?: string) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, [JSON.stringify({ type: "session", version: 3, id: file, parentSession }), ...entries.map(JSON.stringify), "{partial"].join("\n"));
	};
	const base = path.join(runsRoot(), "billing-abc123");
	const original = path.join(base, "agents/0/attempt-0/original.jsonl");
	const fork = path.join(base, "agents/0/attempt-0/fork.jsonl");
	save(original, [entry("a", 1), entry("b", 2), entry("t", 0.5, "tool"), entry("u", 0.25, "usage"), entry("c", 0.125, "compaction"), entry("s", 0.0625, "branch_summary"), { type: "custom", id: "meta", usage: { cost: { total: 999 } } }]);
	save(fork, [entry("a", 1), entry("f", 3)], original);
	save(path.join(base, "agents/0/attempt-1/retry.jsonl"), [entry("retry", 4)]);
	save(path.join(base, "agents/1/session.jsonl"), [entry("a", 5)]); // same entry id in an unrelated file
	assert.equal(readRunUsage(base).usage.cost, 15.9375);
	assert.equal(readRunUsage(base).agents.get(0)?.cost, 10.9375);
	const resumed = path.join(runsRoot(), "billing-resumed-abc123");
	fs.mkdirSync(resumed, { recursive: true });
	fs.writeFileSync(path.join(resumed, "run.json"), JSON.stringify({ resumedFrom: "billing-abc123" }));
	save(path.join(resumed, "agents/0/session.jsonl"), [entry("new", 6)]);
	save(path.join(resumed, "agents/1/fork.jsonl"), [entry("a", 5), entry("extra", 1)], path.join(base, "agents/1/session.jsonl"));
	assert.equal(readRunUsage(resumed).usage.cost, 22.9375);
	assert.equal(readRunUsage(resumed).agents.get(0)?.cost, 6, "per-agent detail is current-run only");
	// Registry recovery reads the same sessions even without a result.json.
	fs.writeFileSync(path.join(base, "script.js"), "return 1");
	const { readRun } = await import("../extensions/ultracode/registry.ts");
	assert.equal(readRun("billing-abc123")?.usage.cost, 15.9375);
}

// A running child is visible before completion; its persisted messages replace (not
// augment) streaming estimates. Retries keep their first child session on disk.
{
	let complete!: (value: SpawnResult) => void;
	let first = true;
	const agentRunner = async (o: SpawnOptions): Promise<SpawnResult> => {
		fs.mkdirSync(o.sessionDir, { recursive: true });
		const file = path.join(o.sessionDir, "child.jsonl");
		fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: file }) + "\n" + JSON.stringify({ type: "message", id: "turn", message: { role: "assistant", usage: { input: 12, output: 3, cost: { total: first ? 2 : 7 } } } }) + "\n");
		o.onUsage?.({ ...emptyUsage(), input: 12, output: 3, cost: 100, turns: 1 });
		if (first) {
			first = false;
			return { text: "", usage: { ...emptyUsage(), cost: 100 }, exitCode: 1, aborted: false };
		}
		return new Promise((resolve) => { complete = resolve; });
	};
	const liveSrc = "return await agent('RETRY')";
	const live = new WorkflowRun(liveSrc, parseScript(liveSrc), undefined, { ...defaults, runAgent: agentRunner });
	const done = live.start();
	for (let i = 0; !complete && i < 100; i++) await new Promise((r) => setTimeout(r, 5));
	assert.ok(complete);
	live.refreshUsage(true);
	assert.equal(live.usage.cost, 9, "live accounting uses both persisted attempts, not streaming events");
	assert.equal(live.agents[0]?.usage.cost, 9);
	complete({ text: "ok", usage: { ...emptyUsage(), cost: 100 }, exitCode: 0, aborted: false });
	await done;
	assert.equal(live.usage.cost, 9);
	const { readRun } = await import("../extensions/ultracode/registry.ts");
	assert.equal(readRun(live.id)?.usage.cost, 9);
	assert.equal(JSON.parse(fs.readFileSync(path.join(live.runDir, "result.json"), "utf8")).usage.cost, 9);
	const replay = await run(liveSrc, undefined, live.id);
	assert.equal(replay.agents[0]?.status, "cached");
	assert.equal(replay.usage.cost, 9, "replay charges original sessions only once");
}

// A missing attempt number must not cause a later retry to reuse an existing directory.
{
	const source = "return await agent('SPARSE')";
	let attempt = 0;
	const sparse = new WorkflowRun(source, parseScript(source), undefined, {
		...defaults,
		runAgent: async (o) => {
			assert.equal(path.basename(o.sessionDir), `attempt-${attempt === 0 ? 3 : 4}`);
			attempt++;
			return { text: "ok", usage: emptyUsage(), exitCode: attempt === 1 ? 1 : 0, aborted: false };
		},
	});
	const agentDir = path.join(sparse.runDir, "agents/0");
	fs.mkdirSync(path.join(agentDir, "attempt-0"), { recursive: true });
	fs.mkdirSync(path.join(agentDir, "attempt-2"), { recursive: true });
	await sparse.start();
	assert.equal(sparse.status, "done", sparse.error);
	assert.equal(attempt, 2);
}

// Command-only activation: ordinary text never changes mode or the system prompt.
{
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const levels: string[] = [];
	let thinking = "medium";
	let branch: any[] = [];
	const pi: any = {
		on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
		registerTool: () => {},
		registerMessageRenderer: () => {},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		appendEntry: (type: string, data: any) => entries.push({ type, data }),
		getThinkingLevel: () => thinking,
		setThinkingLevel: (level: string) => { thinking = level; levels.push(level); },
		getFlag: () => true, // legacy flag must no longer enable mode
	};
	const ctx: any = {
		mode: "json", cwd: process.cwd(), hasUI: false,
		sessionManager: { getSessionId: () => "test-session", getBranch: () => branch },
		ui: { notify: () => {}, setWorkingMessage: () => {} },
	};
	const { default: extension } = await import("../extensions/ultracode/index.ts");
	const depth = process.env.PI_ULTRACODE_DEPTH;
	delete process.env.PI_ULTRACODE_DEPTH;
	try { extension(pi); } finally {
		if (depth !== undefined) process.env.PI_ULTRACODE_DEPTH = depth;
	}
	assert.equal(handlers.has("input"), false, "no keyword input trigger");
	assert.equal(commands.has("ultracode"), true);
	const start = (reason: string) => handlers.get("session_start")!({ reason }, ctx);
	const prompt = () => {
		const event = { systemPromptOptions: { appendSystemPrompt: "" } };
		handlers.get("before_agent_start")!(event, ctx);
		return event.systemPromptOptions.appendSystemPrompt;
	};
	const cmd = async (arg: string) => commands.get("ultracode").handler(arg, ctx);
	start("new");
	assert.equal(prompt().trim(), workflowBasics, "off appends only neutral workflow basics");
	assert.doesNotMatch(prompt(), /# Ultracode mode/);
	assert.equal(thinking, "medium");
	await cmd("off");
	assert.deepEqual(levels, [], "off while already off does not touch thinking");
	assert.equal(entries.at(-1)?.data.on, false);
	assert.equal(prompt().trim(), workflowBasics);
	await cmd("");
	assert.equal(thinking, "xhigh");
	assert.match(prompt(), /# Ultracode mode \(on\)/);
	assert.deepEqual(entries.at(-1)?.data, { on: true, previousThinking: "medium" });
	const priorEntries = entries.length;
	await cmd("status");
	assert.equal(entries.length, priorEntries, "status does not change the mode");
	await cmd("");
	assert.equal(thinking, "medium", "bare command toggles off");
	await cmd("on");
	assert.equal(thinking, "xhigh");
	await cmd("off");
	assert.equal(thinking, "medium");
	assert.equal(prompt().trim(), workflowBasics);
	await cmd("on");
	branch = [{ type: "custom", customType: "ultracode-mode", data: entries.at(-1)?.data }];
	thinking = "medium";
	start("resume");
	assert.equal(thinking, "xhigh");
	await cmd("off");
	assert.equal(thinking, "medium", "resume restores the saved pre-mode level");
	branch.push({ type: "custom", customType: "ultracode-mode", data: { on: false } });
	start("reload");
	assert.equal(thinking, "medium");
	assert.equal(prompt().trim(), workflowBasics);
}

console.log("ok");
