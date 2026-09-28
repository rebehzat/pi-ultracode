import * as fs from "node:fs";
import * as path from "node:path";
import { addUsage, emptyUsage, type Usage } from "./agent.ts";

type Session = { file: string; parent?: string; entries: { id?: string; usage: any; turn: boolean }[] };

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

function readSession(file: string): Session | undefined {
	let lines: string[];
	try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { return undefined; }
	let header: any;
	try { header = JSON.parse(lines[0]!); } catch { return undefined; }
	if (header?.type !== "session") return undefined;
	const entries: Session["entries"] = [];
	for (const line of lines.slice(1)) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			const item = billable(entry);
			if (item) entries.push({ ...item, id: entry.id });
		} catch { /* A live writer may leave a partial final line. */ }
	}
	return { file, parent: typeof header.parentSession === "string" ? path.resolve(path.dirname(file), header.parentSession) : undefined, entries };
}

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
			const inherited = new Set<string>();
			for (const ancestor of ancestors) for (const e of knownSessions.get(ancestor)!.entries) if (e.id) inherited.add(e.id);
			const seen = new Set<string>();
			for (const e of session.entries) {
				if (e.id && (seen.has(e.id) || inherited.has(e.id))) continue;
				if (e.id) seen.add(e.id);
				const u = e.usage;
				addUsage(subtotal, {
					input: Number(u.input) || 0, output: Number(u.output) || 0,
					cacheRead: Number(u.cacheRead) || 0, cacheWrite: Number(u.cacheWrite) || 0,
					cost: Number(u.cost?.total) || 0, turns: e.turn ? 1 : 0,
				});
			}
		}
		agents.set(index, subtotal);
		addUsage(usage, subtotal);
	}
	return { usage, agents, files };
}
