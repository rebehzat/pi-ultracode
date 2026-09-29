import { randomBytes } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Usage } from "./agent.ts";
import type { RunTransition, WorkflowRun } from "./runtime.ts";

/** The only data copied to the parent transcript. Never use run ids, script metadata,
 * agent labels, prompts, activity, errors, paths or process details as display text. */
export interface ProgressUsage {
	totalTokens: number;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	costUsd?: number;
}
export interface ProgressSnapshot {
	version: 1;
	sessionId: string;
	taskId: string;
	kind: "workflow_run" | "workflow_member";
	status: "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
	runId: string;
	agentIndex?: number;
	workflowName?: string;
	title?: string;
	phaseIndex?: number;
	phaseTitle?: string;
	phases?: { index: number; title: string }[];
	startedAt?: string;
	updatedAt: string;
	endedAt?: string;
	usage: ProgressUsage;
}

const opaqueId = () => randomBytes(16).toString("hex");
const tokens = (n: number) => Number.isSafeInteger(n) && n >= 0 ? n : 0;
const timestamp = (n: number) => new Date(n).toISOString();
function usage(u: Usage): ProgressUsage {
	const input = tokens(u.input + u.cacheWrite);
	const cached = tokens(u.cacheRead);
	const output = tokens(u.output);
	const costUsd = Number.isFinite(u.cost) && u.cost >= 0 ? u.cost : undefined;
	return {
		totalTokens: tokens(input + cached + output), inputTokens: input,
		cachedInputTokens: cached, outputTokens: output,
		...(costUsd === undefined ? {} : { costUsd }),
	};
}

/** One emitter per run. Pi's current session is checked immediately before every append,
 * including callbacks from background runs after a session switch. No timers or polling. */
export function observeProgress(
	pi: Pick<ExtensionAPI, "appendEntry">,
	run: WorkflowRun,
	sessionId: string,
	activeSessionId: () => string | undefined,
): (event: RunTransition | { type: "launch" }) => void {
	const runId = opaqueId();
	const memberIds = new Map<number, string>();
	const append = (record: ProgressSnapshot) => {
		if (activeSessionId() === sessionId) pi.appendEntry("piano-task-progress", record);
	};
	// Display positions only: script-defined phase names never enter the transcript.
	const phase = (index: number) => index >= 0 && index < Math.min(run.phases.length, 32)
		? { phaseIndex: index, phaseTitle: `Phase #${index + 1}` } : {};
	return (event) => {
		// Don't scan child transcripts, or do any more work, once the initiating session is gone.
		if (activeSessionId() !== sessionId) return;
		const now = timestamp(Date.now());
		if (event.type === "member_start" || event.type === "member_settle") {
			const a = run.agents[event.index];
			if (!a) return;
			let id = memberIds.get(a.index);
			if (!id) { id = opaqueId(); memberIds.set(a.index, id); }
			const status = a.status === "done" || a.status === "cached" ? "completed"
				: a.status === "failed" ? "failed"
				: a.status === "stopped" ? run.status === "interrupted" ? "interrupted" : "cancelled"
				: a.status === "queued" ? "pending" : "running";
			append({ version: 1, sessionId, taskId: id, kind: "workflow_member", runId,
				agentIndex: a.index, status, title: `Agent #${a.index + 1}`,
				...phase(run.phases.indexOf(a.phase ?? "")),
				...(a.startedAt === undefined ? {} : { startedAt: timestamp(a.startedAt) }),
				updatedAt: now, ...(a.endedAt === undefined ? {} : { endedAt: timestamp(a.endedAt) }),
				usage: usage(a.usage) });
			return;
		}
		const status = run.status === "done" ? "completed" : run.status === "failed" ? "failed"
			: run.status === "stopped" ? "cancelled" : run.status === "interrupted" ? "interrupted"
			: run.status === "paused" ? "waiting" : "running";
		const phaseIndex = event.type === "phase_start" ? event.index :
			event.type === "phase_end" ? undefined : run.currentPhase === undefined ? undefined : run.phases.indexOf(run.currentPhase);
		append({ version: 1, sessionId, taskId: runId, kind: "workflow_run", runId,
			status, workflowName: "Workflow", title: "Workflow",
			phases: run.phases.slice(0, 32).map((_, index) => ({ index, title: `Phase #${index + 1}` })),
			...(phaseIndex === undefined ? {} : phase(phaseIndex)),
			startedAt: timestamp(run.startedAt), updatedAt: now,
			...(event.type === "completion" ? { endedAt: timestamp(run.endedAt ?? Date.now()) } : {}),
			usage: usage(run.usage) });
	};
}
