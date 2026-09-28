import * as fs from "node:fs";
import * as path from "node:path";
import { addUsage, emptyUsage, type Usage } from "./agent.ts";

type Session = { file: string; parent?: string; entries: { id?: string; usage: any; turn: boolean }[] };
type CachedSession = {
	dev: bigint; ino: bigint; size: number; mtime: bigint; ctime: bigint;
	// Only newline-terminated records are committed. A final line is parsed for this
	// snapshot but reread next time, since the writer may still extend it.
	offset: number; headerSeen: boolean; valid: boolean; parent?: string;
	entries: Session["entries"]; tail: Buffer;
	// Includes a valid unterminated final record, if present. Reusable only while
	// size and timestamps are unchanged; growth must reparse that record.
	snapshot?: Session;
};

// Cap retained data across runs. The cache stores only billable records, never the
// entire JSONL text; old/inactive sessions are evicted in LRU order.
const MAX_CACHED_BYTES = 256 * 1024 * 1024;
const MAX_CACHED_FILES = 2048;
const sessions = new Map<string, CachedSession>();
let cachedBytes = 0;
const weight = (session: CachedSession) => session.size + session.tail.length;
function forget(file: string): void {
	const previous = sessions.get(file);
	if (previous) cachedBytes -= weight(previous);
	sessions.delete(file);
}
function remember(file: string, session: CachedSession, oldWeight?: number): void {
	const previous = sessions.get(file);
	if (previous) cachedBytes -= oldWeight ?? weight(previous);
	sessions.delete(file);
	if (weight(session) > MAX_CACHED_BYTES) return;
	sessions.set(file, session);
	cachedBytes += weight(session);
	while (cachedBytes > MAX_CACHED_BYTES || sessions.size > MAX_CACHED_FILES) {
		const oldest = sessions.keys().next().value!;
		cachedBytes -= weight(sessions.get(oldest)!);
		sessions.delete(oldest);
	}
}

/** Billable Pi entries, not JSON-mode events, journal roll-ups or result.json summaries. */
function billable(entry: any): { usage: any; turn: boolean } | undefined {
	if (entry?.type === "message" && entry.message?.role === "assistant" && entry.message.usage)
		return { usage: entry.message.usage, turn: true };
	if (entry?.type === "message" && entry.message?.role === "toolResult" && entry.message.usage)
		return { usage: entry.message.usage, turn: false };
	if (entry?.type === "usage" && entry.usage) return { usage: entry.usage, turn: false };
	if ((entry?.type === "compaction" || entry?.type === "branch_summary") && entry.usage)
		return { usage: entry.usage, turn: false };
	return undefined;
}

function sessionFiles(dir: string): string[] {
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
	return entries.flatMap((entry) => {
		const file = path.join(dir, entry.name);
		return entry.isDirectory() ? sessionFiles(file) : entry.isFile() && entry.name.endsWith(".jsonl") ? [file] : [];
	});
}

function record(session: CachedSession, file: string, line: Buffer): void {
	if (!line.length || !line.toString("utf8").trim()) {
		if (!session.headerSeen) session.headerSeen = true;
		return;
	}
	let entry: any;
	try { entry = JSON.parse(line.toString("utf8")); } catch {
		if (!session.headerSeen) session.headerSeen = true;
		return;
	}
	if (!session.headerSeen) {
		session.headerSeen = true;
		session.valid = entry?.type === "session";
		if (session.valid && typeof entry.parentSession === "string")
			session.parent = path.resolve(path.dirname(file), entry.parentSession);
		return;
	}
	if (!session.valid) return;
	const item = billable(entry);
	if (item) session.entries.push({ ...item, id: entry.id });
}

function readSession(file: string): Session | undefined {
	let fd: number;
	try { fd = fs.openSync(file, "r"); } catch { return undefined; }
	try {
		const stat = fs.fstatSync(fd, { bigint: true });
		const size = Number(stat.size);
		let cached = sessions.get(file);
		if (cached && cached.dev === stat.dev && cached.ino === stat.ino &&
			cached.size === size && cached.mtime === stat.mtimeNs && cached.ctime === stat.ctimeNs) {
			remember(file, cached);
			return cached.snapshot;
		}
		// Size alone is insufficient: an in-place rewrite or a replacement can
		// preserve it. On growth, verify the previous end as well, to distinguish
		// ordinary appends from a rewrite of the same inode.
		let append = !!cached && cached.dev === stat.dev && cached.ino === stat.ino &&
			size >= cached.size && (size > cached.size ||
				(cached.mtime === stat.mtimeNs && cached.ctime === stat.ctimeNs));
		if (append && cached && size > cached.size && cached.size) {
			const checkSize = Math.min(128, cached.size);
			const check = Buffer.allocUnsafe(checkSize);
			const got = fs.readSync(fd, check, 0, checkSize, cached.size - checkSize);
			append = got === checkSize && check.equals(cached.tail.subarray(Math.max(0, cached.tail.length - checkSize)));
		}
		// The end check must include bytes before the pending line. Keep this
		// fingerprint separately from the pending record buffer.
		if (!append) cached = undefined;
		const oldWeight = sessions.has(file) ? weight(sessions.get(file)!) : undefined;
		const session: CachedSession = cached ?? {
			dev: stat.dev, ino: stat.ino, size: 0, mtime: stat.mtimeNs, ctime: stat.ctimeNs,
			offset: 0, headerSeen: false, valid: false, entries: [], tail: Buffer.alloc(0),
		};
		// Keep line fragments rather than repeatedly copying/scanning the entire
		// prefix of a multi-megabyte line on each 64 KiB read. Decode UTF-8 only
		// after the newline (or when making a final partial-record snapshot).
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let position = session.offset;
		let fragments: Buffer[] = [];
		let pendingLength = 0;
		while (position < size) {
			const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
			if (!n) break;
			position += n;
			let start = 0;
			let end: number;
			while ((end = chunk.indexOf(10, start)) < n && end !== -1) {
				const part = chunk.subarray(start, end);
				if (fragments.length) {
					if (part.length) { fragments.push(part); pendingLength += part.length; }
					record(session, file, Buffer.concat(fragments, pendingLength));
					fragments = [];
					pendingLength = 0;
				} else record(session, file, part);
				start = end + 1;
			}
			if (start < n) {
				const part = Buffer.from(chunk.subarray(start, n));
				fragments.push(part);
				pendingLength += part.length;
			}
		}
		// If a writer changed the file while reading, discard this scan rather
		// than storing a permanently inconsistent offset.
		const after = fs.fstatSync(fd, { bigint: true });
		if (after.dev !== stat.dev || after.ino !== stat.ino || Number(after.size) < position ||
			after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) {
			forget(file);
			return undefined;
		}
		const previousSize = session.size;
		session.offset = position - pendingLength;
		session.size = position;
		session.mtime = after.mtimeNs;
		session.ctime = after.ctimeNs;
		// The last bytes of the file, including complete lines, are needed to
		// validate the next append. This small read is independent of file size.
		if (!cached || position !== previousSize) {
			const tail = Buffer.allocUnsafe(Math.min(128, position));
			if (tail.length) fs.readSync(fd, tail, 0, tail.length, position - tail.length);
			session.tail = tail;
		}
		if (!pendingLength) session.snapshot = session.valid ? { file, parent: session.parent, entries: session.entries } : undefined;
		else {
			const snapshot: CachedSession = { ...session, entries: session.entries.slice() };
			record(snapshot, file, Buffer.concat(fragments, pendingLength));
			session.snapshot = snapshot.valid ? { file, parent: snapshot.parent, entries: snapshot.entries } : undefined;
		}
		remember(file, session, oldWeight);
		return session.snapshot;
	} catch {
		forget(file);
		return undefined;
	} finally { fs.closeSync(fd); }
}

// An unchanged session (and unchanged ancestors) has an unchanged subtotal.
// Weak keys let eviction of parsed sessions release their accounting as well.
const subtotals = new WeakMap<Session["entries"], { count: number; ancestors: { entries: Session["entries"]; count: number }[]; usage: Usage; seen: Set<string> }>();

/** Scan every agent session, including failed attempts and abandoned branches. Forks copy
 * ancestor entries: an entry copied from an included parent file is charged only once. */
export function readRunUsage(runDir: string, visited = new Set<string>(), knownSessions = new Map<string, Session>()): { usage: Usage; agents: Map<number, Usage>; files: Set<number> } {
	const resolved = path.resolve(runDir);
	if (visited.has(resolved)) return { usage: emptyUsage(), agents: new Map(), files: new Set() };
	visited.add(resolved);
	const agents = new Map<number, Usage>();
	const files = new Set<number>();
	const agentFiles = new Map<number, string[]>();
	const usage = emptyUsage();
	// Load source runs first so forked files in this run can recognize copied
	// ancestor entries even when their parent is in a previous run.
	try {
		const state = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
		const id = state.resumedFrom;
		if (typeof id === "string" && /^[\w.-]+$/.test(id) && id !== "." && id !== "..") {
			addUsage(usage, readRunUsage(path.join(path.dirname(runDir), id), visited, knownSessions).usage);
		}
	} catch { /* Older runs may have no run.json. */ }
	const root = path.join(runDir, "agents");
	let agentDirs: fs.Dirent[] = [];
	try { agentDirs = fs.readdirSync(root, { withFileTypes: true }); } catch {}
	for (const dir of agentDirs) {
		if (!dir.isDirectory() || !/^(0|[1-9]\d*)$/.test(dir.name)) continue;
		const index = Number(dir.name);
		const paths = sessionFiles(path.join(root, dir.name));
		for (const file of paths) {
			const session = readSession(file);
			if (!session) continue;
			knownSessions.set(path.resolve(file), session);
			const list = agentFiles.get(index) ?? [];
			list.push(path.resolve(file));
			agentFiles.set(index, list);
			files.add(index);
		}
	}
	for (const [index, paths] of agentFiles) {
		const subtotal = emptyUsage();
		for (const file of paths) {
			const session = knownSessions.get(file)!;
			const ancestors = new Set<string>();
			let parent = session.parent;
			while (parent && knownSessions.has(parent) && !ancestors.has(parent)) {
				ancestors.add(parent);
				parent = knownSessions.get(parent)!.parent;
			}
			const lineage = [...ancestors].map((ancestor) => {
				const entries = knownSessions.get(ancestor)!.entries;
				return { entries, count: entries.length };
			});
			const previous = subtotals.get(session.entries);
			const sameLineage = previous && previous.count <= session.entries.length &&
				previous.ancestors.length === lineage.length &&
				lineage.every((a, i) => a.entries === previous.ancestors[i]!.entries && a.count === previous.ancestors[i]!.count);
			if (sameLineage && previous.count === session.entries.length) {
				addUsage(subtotal, previous.usage);
				continue;
			}
			const inherited = new Set<string>();
			for (const ancestor of lineage) for (const e of ancestor.entries) if (e.id) inherited.add(e.id);
			const seen = sameLineage ? previous.seen : new Set<string>();
			const current = sameLineage ? previous.usage : emptyUsage();
			for (let i = sameLineage ? previous.count : 0; i < session.entries.length; i++) {
				const e = session.entries[i]!;
				if (e.id && (seen.has(e.id) || inherited.has(e.id))) continue;
				if (e.id) seen.add(e.id);
				const u = e.usage;
				addUsage(current, {
					input: Number(u.input) || 0, output: Number(u.output) || 0,
					cacheRead: Number(u.cacheRead) || 0, cacheWrite: Number(u.cacheWrite) || 0,
					cost: Number(u.cost?.total) || 0, turns: e.turn ? 1 : 0,
				});
			}
			subtotals.set(session.entries, { count: session.entries.length, ancestors: lineage, usage: current, seen });
			addUsage(subtotal, current);
		}
		agents.set(index, subtotal);
		addUsage(usage, subtotal);
	}
	return { usage, agents, files };
}
