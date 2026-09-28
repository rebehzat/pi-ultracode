import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { readRunUsage } from "../extensions/ultracode/usage.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultracode-usage-"));
const entry = (id: string, cost = 1, type = "message") => ({ type, id,
	message: { role: "assistant", usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: { total: cost } } },
	usage: { output: 7, cost: { total: cost } },
});
const save = (file: string, records: unknown[], parentSession?: string, finalNewline = true) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, [JSON.stringify({ type: "session", parentSession }), ...records.map(JSON.stringify)].join("\n") + (finalNewline ? "\n" : ""));
};
try {
	const base = path.join(root, "base");
	const parent = path.join(base, "agents/0/parent.jsonl");
	const child = path.join(base, "agents/0/child.jsonl");
	save(parent, [entry("a"), entry("u", 2, "usage"), entry("c", 3, "compaction"), entry("s", 4, "branch_summary"),
		{ type: "message", id: "t", message: { role: "toolResult", usage: { cacheWrite: 8, cost: { total: 5 } } } },
		{ type: "custom", usage: { cost: { total: 900 } } }]);
	save(child, [entry("a"), entry("b", 6)], parent);
	const resumed = path.join(root, "resumed");
	fs.mkdirSync(resumed);
	fs.writeFileSync(path.join(resumed, "run.json"), JSON.stringify({ resumedFrom: "base" }));
	const fork = path.join(resumed, "agents/1/fork.jsonl");
	save(fork, [entry("a"), entry("new", 7)], parent);
	const read = () => readRunUsage(resumed);
	assert.equal(read().usage.cost, 28);
	assert.equal(read().agents.get(1)?.cost, 7);
	assert.equal(read().usage.cacheWrite, 23);
	assert.equal(read().usage.turns, 3);
	// A live, valid final record without a newline is billable, but must not be
	// committed: appending bytes may invalidate/replace it on the next scan.
	fs.appendFileSync(child, JSON.stringify(entry("live", 8)));
	assert.equal(read().usage.cost, 36);
	fs.appendFileSync(child, "garbage\n");
	assert.equal(read().usage.cost, 28);
	fs.appendFileSync(child, '{"type":"message","id":"later","message":');
	assert.equal(read().usage.cost, 28);
	fs.appendFileSync(child, JSON.stringify({ role: "assistant", usage: { cost: { total: 9 } } }) + "}\n");
	assert.equal(read().usage.cost, 37);
	// Parent changes invalidate the cached fork subtotal as well as the parent.
	fs.appendFileSync(parent, JSON.stringify(entry("new", 10)) + "\n");
	assert.equal(read().usage.cost, 40); // +10 parent, -7 inherited fork
	assert.equal(read().agents.get(1)?.cost, 0);
	// Rewrites of equal length and truncation invalidate prior records.
	const old = fs.readFileSync(parent, "utf8");
	fs.writeFileSync(parent, old.replace('"total":10', '"total":20'));
	assert.equal(read().usage.cost, 50);
	fs.writeFileSync(parent, JSON.stringify({ type: "session" }) + "\n");
	assert.equal(read().usage.cost, 24); // child: 1+6+9, fork: 1+7
	// New inode at the same path must not inherit the old cursor.
	fs.renameSync(parent, parent + ".old");
	save(parent, [entry("fresh", 11)]);
	assert.equal(read().usage.cost, 35);
	fs.appendFileSync(child, JSON.stringify(entry("b", 99)) + "\n");
	assert.equal(read().usage.cost, 35, "appended duplicate IDs stay deduplicated");
	const invalid = path.join(base, "agents/2/bad.jsonl");
	fs.mkdirSync(path.dirname(invalid), { recursive: true });
	fs.writeFileSync(invalid, "{bad}\n" + JSON.stringify({ type: "session" }) + "\n" + JSON.stringify(entry("wrong", 900)) + "\n");
	assert.equal(read().usage.cost, 35, "a later header cannot repair an invalid first record");

	// A >2 MiB JSONL record must be framed in linear time, and UTF-8 split
	// across a 64 KiB read boundary must survive decoding and ID deduplication.
	const longRun = path.join(root, "long-line");
	const longFile = path.join(longRun, "agents/0/session.jsonl");
	const header = JSON.stringify({ type: "session" }) + "\n";
	const idPrefix = JSON.stringify(entry(""));
	const idStart = idPrefix.indexOf('"id":"') + '"id":"'.length;
	const padding = 65535 - Buffer.byteLength(header) - Buffer.byteLength(idPrefix.slice(0, idStart));
	assert.ok(padding > 0);
	const longId = "a".repeat(padding) + "💫" + "b".repeat(2 * 1024 * 1024);
	const first = JSON.stringify(entry(longId, 13));
	assert.equal(Buffer.byteLength(header + first.slice(0, first.indexOf("💫"))) % 65536, 65535);
	const duplicate = JSON.stringify(entry(longId, 900));
	fs.mkdirSync(path.dirname(longFile), { recursive: true });
	fs.writeFileSync(longFile, header + first + "\n" + duplicate); // valid unterminated last line
	let concatenated = 0;
	const originalConcat = Buffer.concat;
	(Buffer as any).concat = (parts: readonly Uint8Array[], length?: number) => {
		concatenated += length ?? parts.reduce((sum, part) => sum + part.length, 0);
		return originalConcat(parts, length);
	};
	try { assert.equal(readRunUsage(longRun).usage.cost, 13); }
	finally { (Buffer as any).concat = originalConcat; }
	assert.ok(concatenated < 12 * 1024 * 1024, `long-line framing copied ${concatenated} bytes`);
	const originalRead = fs.readSync;
	let partialReads = 0;
	(fs as any).readSync = (...args: any[]) => { partialReads++; return (originalRead as any)(...args); };
	syncBuiltinESMExports();
	try { for (let i = 0; i < 4; i++) assert.equal(readRunUsage(longRun).usage.cost, 13); }
	finally { (fs as any).readSync = originalRead; syncBuiltinESMExports(); }
	assert.equal(partialReads, 0, "unchanged multi-megabyte partial record uses its cached snapshot");
	fs.appendFileSync(longFile, "\n");
	assert.equal(readRunUsage(longRun).usage.cost, 13, "finishing the partial record does not double bill");

	const perf = path.join(root, "perf");
	const big = path.join(perf, "agents/0/large.jsonl");
	save(big, Array.from({ length: 30000 }, (_, i) => entry(`id-${i}`)));
	const start = performance.now();
	assert.equal(readRunUsage(perf).usage.cost, 30000);
	const coldMs = performance.now() - start;
	let bytes = 0;
	const original = fs.readSync;
	// Instrument the actual file descriptor reads, including the 128-byte tail
	// check; a warm scan must not fetch the multi-megabyte JSONL body again.
	(fs as any).readSync = (...args: any[]) => {
		const n = (original as any)(...args);
		bytes += n;
		return n;
	};
	syncBuiltinESMExports();
	let warmMs: number;
	try {
		const warmStart = performance.now();
		for (let i = 0; i < 20; i++) assert.equal(readRunUsage(perf).usage.cost, 30000);
		warmMs = performance.now() - warmStart;
	} finally { (fs as any).readSync = original; syncBuiltinESMExports(); }
	assert.equal(bytes, 0, "unchanged sessions require no JSONL reads");
	fs.appendFileSync(big, JSON.stringify(entry("last", 12)) + "\n");
	bytes = 0;
	(fs as any).readSync = (...args: any[]) => {
		const n = (original as any)(...args);
		bytes += n;
		return n;
	};
	syncBuiltinESMExports();
	try { assert.equal(readRunUsage(perf).usage.cost, 30012); }
	finally { (fs as any).readSync = original; syncBuiltinESMExports(); }
	assert.ok(bytes < 1024, `append should only read its new bytes and a short tail, got ${bytes}`);
	console.log(`usage scan benchmark: cold ${coldMs.toFixed(1)}ms; 20 warm ${warmMs.toFixed(1)}ms (${(coldMs * 20 / warmMs).toFixed(1)}x vs cold repeated); file ${(fs.statSync(big).size / 1024 / 1024).toFixed(1)} MiB`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
