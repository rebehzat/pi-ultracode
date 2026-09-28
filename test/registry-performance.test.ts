import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-registry-"));
process.env.PI_CODING_AGENT_DIR = root;
const { listRuns, readRun, runState, interruptedForSession } = await import("../extensions/ultracode/registry.ts");
const { runsRoot } = await import("../extensions/ultracode/runtime.ts");
const base = runsRoot();
const modern = path.join(base, "modern-abc123");
const legacy = path.join(base, "legacy-abc123");
const crashed = path.join(base, "crashed-abc123");
const sessionEntry = (cost: number) => JSON.stringify({ type: "message", id: "a", message: { role: "assistant", usage: { input: 42, output: 3, cost: { total: cost } } } });
const write = (file: string, data: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
try {
	write(path.join(modern, "script.js"), "return 1");
	write(path.join(modern, "run.json"), JSON.stringify({ name: "modern", sessionId: "another-session", status: "done", startedAt: 100, agents: { done: 2, running: 0, failed: 0, total: 3 } }));
	write(path.join(modern, "result.json"), JSON.stringify({ status: "done", result: "x".repeat(2_000_000) }));
	write(path.join(modern, "journal.jsonl"), "{" + "x".repeat(2_000_000) + "}\n");
	write(path.join(modern, "agents/0/attempt-0/session.jsonl"), JSON.stringify({ type: "session" }) + "\n" + sessionEntry(7) + "\n" + " ".repeat(2_000_000));
	write(path.join(crashed, "script.js"), "return 1");
	write(path.join(crashed, "run.json"), JSON.stringify({ name: "crashed", sessionId: "another-session", status: "interrupted", startedAt: 99, agents: { done: 0, total: 1 } }));
	write(path.join(crashed, "journal.jsonl"), '{"key":"a"}\n');
	write(path.join(legacy, "script.js"), "return 1");
	write(path.join(legacy, "journal.jsonl"), '{"key":"a"}\n{"key":"b"}\n');
	write(path.join(legacy, "agents/0/attempt-0/session.jsonl"), JSON.stringify({ type: "session" }) + "\n" + sessionEntry(3) + "\n");
	write(path.join(legacy, "result.json"), JSON.stringify({ name: "old", status: "failed" }));

	const original = fs.readFileSync;
	const originalOpen = fs.openSync;
	const originalRead = fs.readSync;
	const reads: string[] = [];
	const opens: string[] = [];
	let bytes = 0;
	fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: any[]) => {
		const value = (original as any)(file, ...args);
		if (typeof file === "string" && file.startsWith(base)) {
			reads.push(file);
			bytes += typeof value === "string" ? Buffer.byteLength(value) : value.length;
		}
		return value;
	}) as typeof fs.readFileSync;
	fs.openSync = ((file: fs.PathLike, ...args: any[]) => {
		if (typeof file === "string" && file.startsWith(base)) opens.push(file);
		return (originalOpen as any)(file, ...args);
	}) as typeof fs.openSync;
	fs.readSync = ((...args: any[]) => {
		const n = (originalRead as any)(...args);
		bytes += n;
		return n;
	}) as typeof fs.readSync;
	syncBuiltinESMExports();
	try {
		const records = listRuns();
		const record = records.find((r) => r.id === "modern-abc123")!;
		assert.ok(record);
		assert.deepEqual([record.name, record.status, record.done, record.total], ["modern", "done", 2, 3]);
		const discoveryBytes = bytes;
		assert.ok(discoveryBytes < 1000, `discovery read ${discoveryBytes} bytes (expected small metadata only)`);
		assert.deepEqual(reads.filter((f) => f.startsWith(modern)), [path.join(modern, "run.json")]);
		assert.deepEqual(opens, [], "metadata discovery did not open child sessions");
		assert.deepEqual(interruptedForSession("my-session", new Set(), new Set()), []);
		assert.ok(bytes < 1000, "unrelated run filtering did not scan child sessions");
		assert.ok(!reads.includes(path.join(crashed, "journal.jsonl")), "unrelated interrupted count stays lazy");
		const crashedRecord = records.find((r) => r.id === "crashed-abc123")!;
		assert.deepEqual([crashedRecord.done, crashedRecord.total], [1, 1], "interrupted count recovers committed journal entries");
		assert.ok(reads.includes(path.join(crashed, "journal.jsonl")));
		assert.equal(record.usage.cost, 7);
		assert.equal(record.usage.input, 42);
		assert.ok(opens.includes(path.join(modern, "agents/0/attempt-0/session.jsonl")));
		assert.ok(!reads.includes(path.join(modern, "result.json")));
		assert.ok(!reads.includes(path.join(modern, "journal.jsonl")));
		assert.equal(readRun("modern-abc123")?.usage.cost, 7);
		const old = records.find((r) => r.id === "legacy-abc123")!;
		assert.deepEqual([old.name, old.status, old.done, old.total, old.usage.cost], ["old", "failed", 2, 2, 3]);
		assert.equal(runState(old, new Set()), "finished");
		console.log(`registry-performance: discovery read ${discoveryBytes} bytes vs >6,000,000 bytes formerly read eagerly`);
	} finally {
		fs.readFileSync = original;
		fs.openSync = originalOpen;
		fs.readSync = originalRead;
		syncBuiltinESMExports();
	}
	// A crash after result.json but before the terminal run.json write must not
	// present completed work as interrupted or lose final agent counts.
	const finalized = path.join(base, "finalized-abc123");
	write(path.join(finalized, "script.js"), "return 1");
	write(path.join(finalized, "run.json"), JSON.stringify({ name: "finalized", status: "running", pid: 2 ** 22 + 12345, agents: {done: 0, total: 1} }));
	write(path.join(finalized, "result.json"), JSON.stringify({ status: "done", agents: {done: 2, total: 2} }));
	const completed = readRun("finalized-abc123")!;
	assert.equal(completed.status, "done");
	assert.equal(runState(completed, new Set()), "finished");
	assert.deepEqual([completed.done, completed.total], [2, 2]);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
