/** Keep orchestration effort independent from routine worker effort. */
export function agentThinking(configured: string | undefined, current: string): string {
	if (configured && configured !== "inherit") return configured;
	if (configured === "inherit") return current;
	return ["high", "xhigh", "max"].includes(current) ? "medium" : current;
}

/** Reject NaN/Infinity and clamp integer limits before they reach the scheduler. */
export function positiveLimit(value: unknown, fallback: number, max: number): number {
	const n = Number(value);
	return Number.isFinite(n) && n >= 1 ? Math.min(max, Math.floor(n)) : fallback;
}
