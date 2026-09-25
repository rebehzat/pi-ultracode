/**
 * Defences against malformed workflow `args` from the model.
 *
 * Some models wrap list items in `{"item": [...]}` objects, sometimes chaining them so each
 * wrapper holds the next item plus another wrapper, which nests one level deeper per item.
 * `normalizeArgs` undoes that (and JSON-encoded strings) before the script sees `args`.
 * Some providers reject a whole request whose history holds a deeply nested tool call, which
 * breaks every later turn of the session, so `sanitizeContext` shortens deep tool-call
 * arguments in what is sent to the model (the session log keeps the original).
 */

const WRAPPER = "item";
/** Nesting deeper than this in tool-call arguments is cut from the model context. */
export const MAX_ARG_DEPTH = 12;

function isPlainObject(x: unknown): x is Record<string, unknown> {
	return !!x && typeof x === "object" && !Array.isArray(x);
}

function isWrapper(x: unknown): x is { item: unknown } {
	return isPlainObject(x) && Object.keys(x).length === 1 && WRAPPER in x;
}

function parseJsonString(x: string): unknown {
	const t = x.trim();
	if (!/^[[{"]/.test(t)) return x;
	try {
		return JSON.parse(t);
	} catch {
		return x;
	}
}

/** Undo `{"item": …}` wrappers (including chained ones) and JSON-encoded strings. */
export function normalizeArgs(value: unknown, budget = 200): unknown {
	if (budget <= 0) return value;
	if (typeof value === "string") {
		const parsed = parseJsonString(value);
		return parsed === value ? value : normalizeArgs(parsed, budget - 1);
	}
	if (isWrapper(value)) return normalizeArgs(value.item, budget - 1);
	if (Array.isArray(value)) {
		const out: unknown[] = [];
		const pending = [...value];
		while (pending.length) {
			const v = pending.shift();
			// A chained wrapper inside a list holds more items of the same list: splice them in.
			if (isWrapper(v) && Array.isArray(v.item)) pending.unshift(...v.item);
			else out.push(normalizeArgs(v, budget - 1));
		}
		return out;
	}
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = normalizeArgs(v, budget - 1);
		return out;
	}
	return value;
}

export function depth(x: unknown): number {
	let max = 0;
	const stack: [unknown, number][] = [[x, 0]];
	while (stack.length) {
		const [v, d] = stack.pop()!;
		if (!v || typeof v !== "object") continue;
		max = Math.max(max, d + 1);
		for (const c of Array.isArray(v) ? v : Object.values(v)) stack.push([c, d + 1]);
	}
	return max;
}

/** Replace anything nested deeper than `limit` with a short note. */
function clip(x: unknown, limit: number): unknown {
	if (!x || typeof x !== "object") return x;
	if (limit <= 0) return `[omitted: nested ${depth(x)} levels deep]`;
	if (Array.isArray(x)) return x.map((v) => clip(v, limit - 1));
	return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, clip(v, limit - 1)]));
}

/** Copy of `messages` with over-deep tool-call arguments clipped, or undefined when nothing needed changing. */
export function sanitizeContext<T>(messages: T[]): T[] | undefined {
	let changed = false;
	const out = messages.map((m: any) => {
		if (m?.role !== "assistant" || !Array.isArray(m.content)) return m;
		let touched = false;
		const content = m.content.map((c: any) => {
			if (c?.type !== "toolCall" || depth(c.arguments) <= MAX_ARG_DEPTH) return c;
			touched = true;
			return { ...c, arguments: clip(c.arguments, MAX_ARG_DEPTH) };
		});
		if (!touched) return m;
		changed = true;
		return { ...m, content };
	});
	return changed ? out : undefined;
}
