import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Box, Spacer, Text } from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { repeatedActionDetected, shouldWarnForBudget, stopReason } from "./accounting";
import { budgetLimitPrompt, continuationPrompt, supersededContinuationMessage } from "./prompts";
import { createRecoveryState, isContextOverflowError, planRecoveryForAssistantMessage, resetRecoveryState, type RecoveryState } from "./recovery";
import { sessionKey } from "./state";
import { GOAL_TOOL_NAMES, registerGoalTools } from "./tools";
import { tokenDeltaFromUsage } from "./usage";

const CUSTOM_TYPE = "pi-goal";
const EVENT_TYPE = "pi-goal-event";
const DEFAULT_EXPORT_FILE = "pi-goal.md";

const BUDGET_WARNING_THRESHOLDS = [0.8, 0.95] as const;
const MAX_EVIDENCE_ENTRIES = 80;
const MAX_RECENT_ACTIONS = 12;
const REPEATED_ACTION_LIMIT = 4;
const NO_FILE_CHANGE_TURN_LIMIT = 5;
const PROACTIVE_COMPACT_AT_PERCENT = 70;

type GoalStatus = "active" | "paused" | "budget_limited" | "complete";

type GoalEvidenceKind = "tool" | "command" | "file" | "test" | "note";

type GoalEvidence = {
	kind: GoalEvidenceKind;
	timestamp: number;
	turn: number;
	title: string;
	summary: string;
	isError?: boolean;
};

type GoalState = {
	version: 1;
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget: number | null;
	tokensUsed: number;
	timeUsedSeconds: number;
	turnsUsed: number;
	maxTurns: number | null;
	maxMinutes: number | null;
	checkpointEvery: number | null;
	lastAction: string | null;
	budgetWarnings: number[];
	evidenceLedger: GoalEvidence[];
	stopReason?: string;
	createdAt: number;
	updatedAt: number;
};

type GoalEventKind =
	| "active"
	| "continuation"
	| "paused"
	| "resumed"
	| "cleared"
	| "budget_limited"
	| "budget_warning"
	| "checkpoint"
	| "anti_thrash"
	| "recovery"
	| "complete"
	| "exported"
	| "imported";

type PendingControlPrompt = {
	goalId: string;
	prompt: string;
	kind: "continuation" | "budget_limit";
	createdAt: number;
};

type PendingContextCompaction = {
	goalId: string;
	reason: string;
};

type SessionRuntime = {
	goal: GoalState | null;
	activeTurnStartedAt: number | null;
	continuationQueuedFor: string | null;
	continuationTimer: ReturnType<typeof setTimeout> | null;
	retryTimer: ReturnType<typeof setTimeout> | null;
	pendingControlPrompt: PendingControlPrompt | null;
	pendingContextCompaction: PendingContextCompaction | null;
	contextCompactionInFlight: boolean;
	recovery: RecoveryState;
	currentTurnToolCalls: string[];
	currentTurnFileTouched: boolean;
	recentActions: string[];
	noFileChangeTurns: number;
	statusBarEnabled: boolean;
	lastCtx?: ExtensionContext;
};

type ParsedGoalArgs = {
	objective: string;
	tokenBudget: number | null;
	maxTurns: number | null;
	maxMinutes: number | null;
	checkpointEvery: number | null;
	error?: string;
};

const runtimes = new Map<string, SessionRuntime>();

function runtimeFor(ctx: ExtensionContext): SessionRuntime {
	const key = sessionKey(ctx);
	let runtime = runtimes.get(key);
	if (!runtime) {
		runtime = {
			goal: null,
			activeTurnStartedAt: null,
			continuationQueuedFor: null,
			continuationTimer: null,
			retryTimer: null,
			pendingControlPrompt: null,
			pendingContextCompaction: null,
			contextCompactionInFlight: false,
			recovery: createRecoveryState(),
			currentTurnToolCalls: [],
			currentTurnFileTouched: false,
			recentActions: [],
			noFileChangeTurns: 0,
			statusBarEnabled: true,
		};
		runtimes.set(key, runtime);
	}
	runtime.lastCtx = ctx;
	return runtime;
}

function normalizeGoal(raw: any): GoalState | null {
	if (!raw) return null;
	return {
		version: 1,
		id: String(raw.id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`),
		objective: String(raw.objective ?? ""),
		status: raw.status ?? "paused",
		tokenBudget: typeof raw.tokenBudget === "number" ? raw.tokenBudget : null,
		tokensUsed: Math.max(0, Number(raw.tokensUsed) || 0),
		timeUsedSeconds: Math.max(0, Number(raw.timeUsedSeconds) || 0),
		turnsUsed: Math.max(0, Number(raw.turnsUsed) || 0),
		maxTurns: typeof raw.maxTurns === "number" ? raw.maxTurns : null,
		maxMinutes: typeof raw.maxMinutes === "number" ? raw.maxMinutes : null,
		checkpointEvery: typeof raw.checkpointEvery === "number" ? raw.checkpointEvery : null,
		lastAction: typeof raw.lastAction === "string" ? raw.lastAction : null,
		budgetWarnings: Array.isArray(raw.budgetWarnings) ? raw.budgetWarnings.filter((v: any) => typeof v === "number") : [],
		evidenceLedger: Array.isArray(raw.evidenceLedger) ? raw.evidenceLedger.slice(-MAX_EVIDENCE_ENTRIES) : [],
		stopReason: typeof raw.stopReason === "string" ? raw.stopReason : undefined,
		createdAt: Number(raw.createdAt) || Date.now(),
		updatedAt: Number(raw.updatedAt) || Date.now(),
	};
}

function parseNumberWithSuffix(rawValue: string, label: string): { value?: number; error?: string } {
	const raw = rawValue.replace(/\s+/g, "");
	const suffix = raw.slice(-1).toLowerCase();
	const numeric = suffix === "k" || suffix === "m" ? raw.slice(0, -1) : raw;
	const value = Number(numeric);
	if (!Number.isFinite(value) || value <= 0) return { error: `${label} must be positive.` };
	const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
	return { value: Math.round(value * multiplier) };
}

function parseGoalArgs(input: string): ParsedGoalArgs {
	let objective = input.trim();
	const result: ParsedGoalArgs = {
		objective: "",
		tokenBudget: null,
		maxTurns: null,
		maxMinutes: null,
		checkpointEvery: null,
	};
	const specs: Array<[keyof ParsedGoalArgs, RegExp, string, (value: number) => number]> = [
		["tokenBudget", /(?:^|\s)--tokens(?:=|\s+)([0-9]+(?:\.[0-9]+)?\s*[kKmM]?)(?=\s|$)/, "Token budget", (value) => value],
		["maxTurns", /(?:^|\s)--max-turns(?:=|\s+)([0-9]+)(?=\s|$)/, "Max turns", (value) => value],
		["maxMinutes", /(?:^|\s)--max-minutes(?:=|\s+)([0-9]+)(?=\s|$)/, "Max minutes", (value) => value],
		["checkpointEvery", /(?:^|\s)--checkpoint(?:=|\s+)([0-9]+)(?=\s|$)/, "Checkpoint interval", (value) => value],
	];
	for (const [key, regex, label, transform] of specs) {
		const match = objective.match(regex);
		if (!match) continue;
		const parsed = key === "tokenBudget" ? parseNumberWithSuffix(match[1], label) : { value: Number(match[1]) };
		if (!parsed.value || !Number.isFinite(parsed.value) || parsed.value <= 0) return { ...result, objective: input.trim(), error: parsed.error ?? `${label} must be positive.` };
		(result as any)[key] = transform(parsed.value);
		objective = (objective.slice(0, match.index) + " " + objective.slice((match.index ?? 0) + match[0].length)).trim();
	}
	return { ...result, objective };
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
	if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
	return String(value);
}

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function statusLine(state: GoalState | null): string | undefined {
	if (!state) return undefined;
	const parts = [`${state.turnsUsed}${state.maxTurns ? `/${state.maxTurns}` : ""} turns`];
	parts.push(state.tokenBudget ? `${formatTokens(state.tokensUsed)}/${formatTokens(state.tokenBudget)}` : formatElapsed(state.timeUsedSeconds));
	if (state.maxMinutes) parts.push(`${formatElapsed(state.timeUsedSeconds)}/${state.maxMinutes}m`);
	if (state.lastAction) parts.push(`last: ${state.lastAction}`);
	const suffix = ` · ${parts.join(" · ")}`;
	if (state.status === "active") return `Goal: active${suffix}`;
	if (state.status === "paused") return `Goal paused${suffix}`;
	if (state.status === "budget_limited") return `Goal unmet${suffix}`;
	return `Goal achieved${suffix}`;
}

function goalUsage(state: GoalState): string {
	const items = [
		`${state.turnsUsed}${state.maxTurns ? ` / ${state.maxTurns}` : ""} turns`,
		state.tokenBudget != null ? `${formatTokens(state.tokensUsed)} / ${formatTokens(state.tokenBudget)} tokens` : `${formatElapsed(state.timeUsedSeconds)} elapsed`,
	];
	if (state.maxMinutes != null) items.push(`${formatElapsed(state.timeUsedSeconds)} / ${state.maxMinutes}m`);
	if (state.checkpointEvery != null) items.push(`checkpoint every ${state.checkpointEvery} turns`);
	return items.join(" · ");
}

function truncateText(value: unknown, max = 280): string {
	const singleLine = String(value ?? "").replace(/\s+/g, " ").trim();
	return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

function truncateObjective(objective: string, max = 96): string {
	return truncateText(objective, max);
}

function goalEventStatus(kind: GoalEventKind): string {
	const labels: Record<GoalEventKind, string> = {
		active: "active",
		continuation: "continuing",
		paused: "paused",
		resumed: "resumed",
		cleared: "cleared",
		budget_limited: "budget reached",
		budget_warning: "budget warning",
		checkpoint: "checkpoint",
		anti_thrash: "stuck",
		recovery: "recovery",
		complete: "achieved",
		exported: "exported",
		imported: "imported",
	};
	return labels[kind];
}

function goalContentForLLM(kind: GoalEventKind, state: GoalState | null, fallback?: string): string {
	if (!state) return fallback ?? `Goal ${goalEventStatus(kind)}.`;
	switch (kind) {
		case "active":
		case "continuation":
		case "resumed":
			return continuationPrompt(state);
		case "budget_limited":
			return budgetLimitPrompt(state);
		case "paused":
			return `The active goal has been paused by the user. Stop pursuing it for now and wait for further instructions.\n\nObjective: ${state.objective}`;
		case "cleared":
			return `The active goal has been cleared by the user. Stop pursuing it.\n\nObjective was: ${state.objective}`;
		case "complete":
			return `The goal has been marked complete.\n\nObjective: ${state.objective}\nUsage: ${goalUsage(state)}`;
		case "budget_warning":
		case "checkpoint":
		case "anti_thrash":
		case "recovery":
		case "exported":
		case "imported":
			return fallback ?? `Goal ${goalEventStatus(kind)}.\n\nObjective: ${state.objective}\nUsage: ${goalUsage(state)}`;
	}
}

const GOAL_CONTROL_CONTEXT_KINDS = new Set<GoalEventKind>(["active", "continuation", "resumed", "budget_limited"]);

function isPiGoalCustomMessage(message: any): boolean {
	return message?.role === "custom" && message?.customType === EVENT_TYPE;
}

function compactGoalControlMessage(state: GoalState): string {
	const evidence = state.evidenceLedger.slice(-5).map((item) => `- [turn ${item.turn}] ${item.title}: ${item.summary}`).join("\n") || "- none yet";
	return `Current pi-goal control state.\nObjective: ${state.objective}\nStatus: ${state.status}\nUsage: ${goalUsage(state)}\nLast action: ${state.lastAction ?? "none"}\nRecent evidence:\n${evidence}`;
}

function prunePiGoalMessagesForContext(messages: any[], currentGoal: GoalState | null, compactKept = false): any[] {
	let keptLatestControl = false;
	const result: any[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!isPiGoalCustomMessage(message)) {
			result.push(message);
			continue;
		}
		const details = message.details ?? {};
		const kind = (details.kind ?? "continuation") as GoalEventKind;
		const messageGoal = normalizeGoal(details.goal) ?? null;
		if (details.superseded) continue;
		if (currentGoal?.id && messageGoal?.id && messageGoal.id !== currentGoal.id) continue;
		if (!GOAL_CONTROL_CONTEXT_KINDS.has(kind)) continue;
		if (keptLatestControl) continue;
		keptLatestControl = true;
		result.push(compactKept && messageGoal ? { ...message, content: compactGoalControlMessage(messageGoal) } : message);
	}
	return result.reverse();
}

function goalCompactionInstructions(state: GoalState): string {
	return [
		"pi-goal compaction guidance:",
		`- Preserve the current goal objective exactly enough to continue: ${truncateObjective(state.objective, 220)}`,
		`- Preserve goal status, usage, last action, blockers, and the most important evidence from the ledger.`,
		"- Do not copy repeated <pi_goal_continuation> prompts, superseded-continuation bookkeeping, or repeated completion-audit boilerplate; summarize them once if relevant.",
	].join("\n");
}

// Emit a goal event into the conversation. The LLM-visible content is always
// actionable text derived from kind + state, so continuation does not depend on
// hidden system-prompt injection.
function emitGoalEvent(
	pi: ExtensionAPI,
	kind: GoalEventKind,
	state: GoalState | null,
	content?: string,
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn"; display?: boolean },
) {
	const { display, ...sendOptions } = options ?? {};
	pi.sendMessage(
		{
			customType: EVENT_TYPE,
			content: goalContentForLLM(kind, state, content),
			display: display ?? kind !== "continuation",
			details: { kind, goal: state, timestamp: Date.now(), preview: content },
		},
		sendOptions,
	);
}

function latestStateFromSession(ctx: ExtensionContext): { goal: GoalState | null; statusBarEnabled: boolean } {
	const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as any;
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
			return {
				goal: normalizeGoal(entry.data?.goal ?? null),
				statusBarEnabled: entry.data?.statusBarEnabled ?? true,
			};
		}
	}
	return { goal: null, statusBarEnabled: true };
}

function updateStatusBar(ctx: ExtensionContext, runtime: SessionRuntime) {
	ctx.ui.setStatus(CUSTOM_TYPE, runtime.statusBarEnabled ? statusLine(runtime.goal) ?? "" : "");
}

// Expose goal tools to the LLM only while a goal is actively being pursued.
// When no goal exists (or it is paused / complete / budget-limited), keep them
// hidden so unrelated sessions are not tempted to call them every turn.
function syncGoalTools(pi: ExtensionAPI, runtime: SessionRuntime) {
	const want = runtime.goal?.status === "active";
	const active = new Set(pi.getActiveTools());
	for (const name of GOAL_TOOL_NAMES) (want ? active.add(name) : active.delete(name));
	pi.setActiveTools(Array.from(active));
}

function persist(pi: ExtensionAPI, ctx: ExtensionContext, next: GoalState | null) {
	const runtime = runtimeFor(ctx);
	const previous = runtime.goal;
	if (!next || next.status !== "active" || next.id !== previous?.id) {
		cancelQueuedWork(pi, runtime, "goal state changed");
		runtime.pendingContextCompaction = null;
		if (!runtime.contextCompactionInFlight) runtime.recovery.pendingReason = null;
	}
	if (next?.status === "active" && (previous?.id !== next.id || previous.status !== "active")) resetRecoveryState(runtime.recovery);
	runtime.goal = next;
	pi.appendEntry(CUSTOM_TYPE, { goal: next, statusBarEnabled: runtime.statusBarEnabled });
	updateStatusBar(ctx, runtime);
	syncGoalTools(pi, runtime);
}

function persistSettings(pi: ExtensionAPI, ctx: ExtensionContext) {
	const runtime = runtimeFor(ctx);
	pi.appendEntry(CUSTOM_TYPE, { goal: runtime.goal, statusBarEnabled: runtime.statusBarEnabled });
	updateStatusBar(ctx, runtime);
}

function addEvidence(pi: ExtensionAPI, ctx: ExtensionContext, evidence: GoalEvidence) {
	const runtime = runtimeFor(ctx);
	if (!runtime.goal || runtime.goal.status !== "active") return;
	const next: GoalState = {
		...runtime.goal,
		lastAction: evidence.title,
		evidenceLedger: [...runtime.goal.evidenceLedger, evidence].slice(-MAX_EVIDENCE_ENTRIES),
		updatedAt: Date.now(),
	};
	persist(pi, ctx, next);
}

function summarizeToolResult(event: any): string {
	const details = event.details ? truncateText(JSON.stringify(event.details), 180) : "";
	const content = Array.isArray(event.content)
		? event.content.map((item: any) => item?.text ?? item?.content ?? JSON.stringify(item)).join(" ")
		: event.content;
	return truncateText(content || details || (event.isError ? "tool failed" : "tool completed"));
}

function classifyEvidence(toolName: string, input: any): GoalEvidenceKind {
	if (toolName === "bash" && /\b(test|vitest|jest|pytest|cargo test|go test|npm test|pnpm test)\b/.test(String(input?.command ?? ""))) return "test";
	if (toolName === "bash") return "command";
	if (["read", "write", "edit"].includes(toolName)) return "file";
	return "tool";
}

function canQueueContinuation(runtime: SessionRuntime, ctx: ExtensionContext, state: GoalState): boolean {
	return state.status === "active" && runtime.goal?.id === state.id && !runtime.recovery.pendingReason && ctx.isIdle() && !ctx.hasPendingMessages() && !ctx.signal;
}

function clearContinuationTimer(runtime: SessionRuntime) {
	if (runtime.continuationTimer) clearTimeout(runtime.continuationTimer);
	runtime.continuationTimer = null;
}

function clearRetryTimer(runtime: SessionRuntime) {
	if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
	runtime.retryTimer = null;
}

function markQueuedContinuationSuperseded(pi: ExtensionAPI, runtime: SessionRuntime, reason: string) {
	const goalId = runtime.continuationQueuedFor;
	if (!goalId) return;
	pi.sendMessage(
		{
			customType: EVENT_TYPE,
			content: `${supersededContinuationMessage(goalId)}\nReason: ${reason}`,
			display: false,
			details: { kind: "continuation", goal: runtime.goal, timestamp: Date.now(), superseded: true, reason },
		},
		{ deliverAs: "followUp" },
	);
	runtime.continuationQueuedFor = null;
}

function cancelQueuedWork(pi: ExtensionAPI, runtime: SessionRuntime, reason: string) {
	clearContinuationTimer(runtime);
	clearRetryTimer(runtime);
	markQueuedContinuationSuperseded(pi, runtime, reason);
}

function queueContinuation(pi: ExtensionAPI, ctx: ExtensionContext, state: GoalState, delayMs = 0) {
	const runtime = runtimeFor(ctx);
	if (!canQueueContinuation(runtime, ctx, state)) return;
	const usage = delayMs === 0 ? ctx.getContextUsage() : undefined;
	if (usage?.percent != null && usage.percent >= PROACTIVE_COMPACT_AT_PERCENT) {
		scheduleContextCompactionRetry(pi, ctx, state, `context usage ${Math.round(usage.percent)}%; compacting before next goal turn`);
		return;
	}
	if (runtime.continuationQueuedFor) markQueuedContinuationSuperseded(pi, runtime, "newer continuation queued");
	clearContinuationTimer(runtime);
	runtime.continuationQueuedFor = state.id;
	runtime.continuationTimer = setTimeout(() => {
		runtime.continuationTimer = null;
		const queuedFor = runtime.continuationQueuedFor;
		runtime.continuationQueuedFor = null;
		const latest = runtime.goal;
		if (!latest || latest.id !== queuedFor || !canQueueContinuation(runtime, ctx, latest)) {
			if (queuedFor) markQueuedContinuationSuperseded(pi, { ...runtime, continuationQueuedFor: queuedFor }, "goal changed before queued continuation ran");
			return;
		}
		emitGoalEvent(pi, "continuation", latest, undefined, { triggerTurn: true, deliverAs: "followUp", display: false });
	}, delayMs);
	runtime.continuationTimer.unref?.();
}

function scheduleRecoveryRetry(pi: ExtensionAPI, ctx: ExtensionContext, goal: GoalState, reason: string, delayMs: number) {
	const runtime = runtimeFor(ctx);
	cancelQueuedWork(pi, runtime, `recovery retry scheduled: ${reason}`);
	runtime.recovery.pendingReason = reason;
	runtime.retryTimer = setTimeout(() => {
		runtime.retryTimer = null;
		const latest = runtime.goal;
		if (!latest || latest.id !== goal.id || latest.status !== "active") return;
		runtime.recovery.pendingReason = null;
		queueContinuation(pi, ctx, latest);
	}, delayMs);
	runtime.retryTimer.unref?.();
}

function scheduleContextCompactionRetry(pi: ExtensionAPI, ctx: ExtensionContext, goal: GoalState, reason: string) {
	const runtime = runtimeFor(ctx);
	cancelQueuedWork(pi, runtime, `context compaction scheduled: ${reason}`);
	runtime.recovery.pendingReason = reason;
	runtime.pendingContextCompaction = { goalId: goal.id, reason };
	if (runtime.contextCompactionInFlight) return;
	if (!ctx.isIdle() || ctx.signal) {
		emitGoalEvent(pi, "recovery", goal, `Goal recovery pending: ${reason}. Will compact context as soon as the current agent run settles, then resume.`);
		return;
	}
	runContextCompactionRetry(pi, ctx, runtime);
}

function runContextCompactionRetry(pi: ExtensionAPI, ctx: ExtensionContext, runtime: SessionRuntime) {
	const pending = runtime.pendingContextCompaction;
	const goal = runtime.goal;
	if (!pending || !goal || goal.id !== pending.goalId || goal.status !== "active") {
		runtime.pendingContextCompaction = null;
		runtime.recovery.pendingReason = null;
		return;
	}
	if (runtime.contextCompactionInFlight) return;
	if (!ctx.isIdle() || ctx.signal) {
		if (!runtime.retryTimer) {
			runtime.retryTimer = setTimeout(() => {
				runtime.retryTimer = null;
				runContextCompactionRetry(pi, ctx, runtime);
			}, 250);
			runtime.retryTimer.unref?.();
		}
		return;
	}
	runtime.contextCompactionInFlight = true;
	emitGoalEvent(pi, "recovery", goal, `Goal recovery pending: ${pending.reason}. Compacting context now; goal will resume afterward.`);
	ctx.compact({
		customInstructions: goalCompactionInstructions(goal),
		onComplete: () => {
			runtime.contextCompactionInFlight = false;
			runtime.pendingContextCompaction = null;
			const latest = runtime.goal;
			runtime.recovery.pendingReason = null;
			if (!latest || latest.id !== pending.goalId || latest.status !== "active") return;
			emitGoalEvent(pi, "recovery", latest, "Context compaction complete; resuming goal continuation.");
			queueContinuation(pi, ctx, latest, 250);
		},
		onError: (error) => {
			runtime.contextCompactionInFlight = false;
			runtime.pendingContextCompaction = null;
			const latest = runtime.goal;
			runtime.recovery.pendingReason = null;
			if (!latest || latest.id !== pending.goalId || latest.status !== "active") return;
			const next = { ...latest, status: "paused" as GoalStatus, stopReason: `context compaction failed: ${truncateText(error.message, 160)}`, updatedAt: Date.now() };
			persist(pi, ctx, next);
			emitGoalEvent(pi, "recovery", next, `Goal paused because context compaction failed: ${error.message}`);
		},
	});
}

function applyRecoveryPlan(pi: ExtensionAPI, ctx: ExtensionContext, goal: GoalState, message: any): boolean {
	const runtime = runtimeFor(ctx);
	const plan = planRecoveryForAssistantMessage(runtime.recovery, message);
	if (plan.type === "none") return false;
	if (plan.type === "retry") {
		if (isContextOverflowError(String(message?.errorMessage ?? ""))) {
			scheduleContextCompactionRetry(pi, ctx, goal, plan.reason);
			return true;
		}
		scheduleRecoveryRetry(pi, ctx, goal, plan.reason, plan.delayMs);
		emitGoalEvent(pi, "recovery", goal, `Goal recovery pending: ${plan.reason}. Retrying in ${Math.round(plan.delayMs / 1000)}s.`);
		return true;
	}
	const next = { ...goal, status: "paused" as GoalStatus, stopReason: plan.reason, updatedAt: Date.now() };
	persist(pi, ctx, next);
	emitGoalEvent(pi, "recovery", next, `Goal paused for recovery: ${plan.reason}`);
	return true;
}

function resolvePath(ctx: ExtensionContext, file: string): string {
	return isAbsolute(file) ? file : join(ctx.cwd, file);
}

function exportGoalMarkdown(goal: GoalState): string {
	const evidence = goal.evidenceLedger.length
		? goal.evidenceLedger.map((item) => `- ${new Date(item.timestamp).toISOString()} · turn ${item.turn} · ${item.kind} · ${item.title}${item.isError ? " · ERROR" : ""}\n  ${item.summary}`).join("\n")
		: "- No evidence recorded yet.";
	return `# pi-goal export

## Objective

${goal.objective}

## Status

- Status: ${goal.status}
- Usage: ${goalUsage(goal)}
- Last action: ${goal.lastAction ?? "none"}
- Stop reason: ${goal.stopReason ?? "none"}

## Evidence ledger

${evidence}

## Machine-readable state

\`\`\`json
${JSON.stringify(goal, null, 2)}
\`\`\`
`;
}

function parseImportedGoal(content: string): GoalState | null {
	const fenced = content.match(/```json\s*([\s\S]*?)```/);
	const raw = fenced ? fenced[1] : content;
	try {
		return normalizeGoal(JSON.parse(raw));
	} catch {
		return null;
	}
}

export default function piGoal(pi: ExtensionAPI) {
	pi.registerMessageRenderer(EVENT_TYPE, (message, { expanded }, theme) => {
		const details = message.details as { kind?: GoalEventKind; goal?: GoalState | null; timestamp?: number } | undefined;
		const kind = details?.kind ?? "continuation";
		const state = normalizeGoal(details?.goal) ?? null;
		const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
		box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("Goal")), 0, 0));
		box.addChild(new Spacer(1));
		if (!expanded) {
			box.addChild(new Text(`${theme.fg("customMessageText", goalEventStatus(kind))} ${theme.fg("dim", "(ctrl+o to expand)")}`, 0, 0));
			return box;
		}
		const lines = [`${theme.fg("dim", "Status: ")}${theme.fg("customMessageText", goalEventStatus(kind))}`];
		if (state) {
			lines.push(`${theme.fg("dim", "Goal: ")}${theme.fg("customMessageText", state.objective)}`);
			lines.push(`${theme.fg("dim", "Usage: ")}${theme.fg("customMessageText", goalUsage(state))}`);
			if (state.lastAction) lines.push(`${theme.fg("dim", "Last: ")}${theme.fg("customMessageText", state.lastAction)}`);
			if (state.stopReason) lines.push(`${theme.fg("dim", "Reason: ")}${theme.fg("customMessageText", state.stopReason)}`);
			if (state.evidenceLedger.length) lines.push(`${theme.fg("dim", "Evidence: ")}${theme.fg("customMessageText", `${state.evidenceLedger.length} entries`)}`);
		}
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});

	registerGoalTools<GoalState>(pi, {
		runtimeFor,
		persist,
		emitComplete: (goal) => emitGoalEvent(pi, "complete", goal),
	});

	pi.on("context", (event, ctx) => {
		const runtime = runtimeFor(ctx);
		const messages = prunePiGoalMessagesForContext(event.messages as any[], runtime.goal);
		if (messages.length !== event.messages.length || messages.some((message, index) => message !== (event.messages as any[])[index])) return { messages };
	});

	pi.on("session_before_compact", (event, ctx) => {
		const runtime = runtimeFor(ctx);
		if (!runtime.goal) return;
		event.preparation.messagesToSummarize = prunePiGoalMessagesForContext(event.preparation.messagesToSummarize as any[], runtime.goal, true) as any;
		event.preparation.turnPrefixMessages = prunePiGoalMessagesForContext(event.preparation.turnPrefixMessages as any[], runtime.goal, true) as any;
	});

	pi.on("session_compact", (_event, ctx) => {
		const runtime = runtimeFor(ctx);
		const goal = runtime.goal;
		if (!goal || goal.status !== "active") return;
		if (runtime.contextCompactionInFlight) return;
		if (runtime.pendingContextCompaction) return;
		if (runtime.recovery.pendingReason?.includes("context")) {
			runtime.recovery.pendingReason = null;
			queueContinuation(pi, ctx, goal, 250);
		}
	});

	pi.on("tool_call", (event, ctx) => {
		const runtime = runtimeFor(ctx);
		if (!runtime.goal || runtime.goal.status !== "active") return;
		const input = (event as any).input ?? {};
		const signature = `${(event as any).toolName}:${truncateText(input.command ?? input.path ?? JSON.stringify(input), 120)}`;
		runtime.currentTurnToolCalls.push(signature);
		if (["write", "edit"].includes((event as any).toolName)) runtime.currentTurnFileTouched = true;
	});

	pi.on("tool_result", (event, ctx) => {
		const runtime = runtimeFor(ctx);
		if (!runtime.goal || runtime.goal.status !== "active") return;
		const toolName = String((event as any).toolName ?? "tool");
		const input = (event as any).input ?? {};
		const title = `${toolName}: ${truncateText(input.command ?? input.path ?? JSON.stringify(input), 80)}`;
		if (["write", "edit"].includes(toolName)) runtime.currentTurnFileTouched = true;
		addEvidence(pi, ctx, {
			kind: classifyEvidence(toolName, input),
			timestamp: Date.now(),
			turn: runtime.goal.turnsUsed + 1,
			title,
			summary: summarizeToolResult(event),
			isError: Boolean((event as any).isError),
		});
	});

	pi.registerCommand("goal", {
		description: "Set, view, pause, resume, clear, export, import, or configure a long-running goal",
		getArgumentCompletions: (prefix) => {
			const values = ["pause", "resume", "clear", "status", "export", "import", "statusbar", "statusbar on", "statusbar off"];
			const filtered = values.filter((value) => value.startsWith(prefix));
			return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const runtime = runtimeFor(ctx);
			const trimmed = args.trim();
			const now = Date.now();

			if (!trimmed || trimmed === "status") {
				if (!runtime.goal) ctx.ui.notify("Usage: /goal [--tokens 50k] [--max-turns 20] [--max-minutes 60] [--checkpoint 5] <objective>", "info");
				else ctx.ui.notify(`${statusLine(runtime.goal)}
Objective: ${runtime.goal.objective}
Evidence entries: ${runtime.goal.evidenceLedger.length}
Status bar: ${runtime.statusBarEnabled ? "on" : "off"}`, "info");
				return;
			}

			if (trimmed === "statusbar" || trimmed === "statusbar toggle" || trimmed === "statusbar on" || trimmed === "statusbar off") {
				const [, value] = trimmed.split(/\s+/, 2);
				runtime.statusBarEnabled = value === "on" ? true : value === "off" ? false : !runtime.statusBarEnabled;
				persistSettings(pi, ctx);
				ctx.ui.notify(`Goal status bar ${runtime.statusBarEnabled ? "enabled" : "disabled"}.`, "info");
				return;
			}

			if (trimmed === "clear") {
				const previous = runtime.goal;
				runtime.pendingControlPrompt = null;
				persist(pi, ctx, null);
				emitGoalEvent(pi, "cleared", previous);
				return;
			}

			if (trimmed === "pause" || trimmed === "resume") {
				if (!runtime.goal) return ctx.ui.notify("No goal is set.", "warning");
				const status: GoalStatus = trimmed === "pause" ? "paused" : "active";
				const next = { ...runtime.goal, status, stopReason: status === "active" ? undefined : runtime.goal.stopReason, updatedAt: now };
				persist(pi, ctx, next);
				emitGoalEvent(pi, status === "active" ? "resumed" : "paused", next);
				if (status === "active") queueContinuation(pi, ctx, next);
				return;
			}

			if (trimmed.startsWith("export")) {
				if (!runtime.goal) return ctx.ui.notify("No goal is set.", "warning");
				const file = trimmed.slice("export".length).trim() || DEFAULT_EXPORT_FILE;
				const target = resolvePath(ctx, file);
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, exportGoalMarkdown(runtime.goal), "utf8");
				emitGoalEvent(pi, "exported", runtime.goal, `Goal exported to ${target}`);
				return;
			}

			if (trimmed.startsWith("import")) {
				const file = trimmed.slice("import".length).trim();
				if (!file) return ctx.ui.notify("Usage: /goal import <file>", "warning");
				const target = resolvePath(ctx, file);
				if (!existsSync(target)) return ctx.ui.notify(`File not found: ${target}`, "warning");
				const imported = parseImportedGoal(readFileSync(target, "utf8"));
				if (!imported) return ctx.ui.notify(`Could not parse goal export: ${target}`, "warning");
				const next = { ...imported, id: `${now}-${Math.random().toString(16).slice(2)}`, status: "paused" as GoalStatus, updatedAt: now };
				persist(pi, ctx, next);
				emitGoalEvent(pi, "imported", next, `Goal imported paused from ${target}. Use /goal resume to continue.`);
				return;
			}

			const parsed = parseGoalArgs(trimmed);
			if (parsed.error) return ctx.ui.notify(parsed.error, "warning");
			if (!parsed.objective) return ctx.ui.notify("Usage: /goal [--tokens 50k] [--max-turns 20] [--max-minutes 60] [--checkpoint 5] <objective>", "warning");
			if (runtime.goal && runtime.goal.status !== "complete") {
				const ok = await ctx.ui.confirm("Replace goal?", `Current: ${runtime.goal.objective}\n\nNew: ${parsed.objective}`);
				if (!ok) return;
			}
			const next: GoalState = {
				version: 1,
				id: `${now}-${Math.random().toString(16).slice(2)}`,
				objective: parsed.objective,
				status: "active",
				tokenBudget: parsed.tokenBudget,
				tokensUsed: 0,
				timeUsedSeconds: 0,
				turnsUsed: 0,
				maxTurns: parsed.maxTurns,
				maxMinutes: parsed.maxMinutes,
				checkpointEvery: parsed.checkpointEvery,
				lastAction: null,
				budgetWarnings: [],
				evidenceLedger: [],
				createdAt: now,
				updatedAt: now,
			};
			persist(pi, ctx, next);
			if (ctx.isIdle() && !ctx.hasPendingMessages()) emitGoalEvent(pi, "active", next, undefined, { triggerTurn: true });
			else emitGoalEvent(pi, "active", next);
		},
	});

	pi.on("session_start", (event, ctx) => {
		const runtime = runtimeFor(ctx);
		const restored = latestStateFromSession(ctx);
		runtime.goal = restored.goal;
		runtime.statusBarEnabled = restored.statusBarEnabled;
		runtime.pendingControlPrompt = null;
		runtime.pendingContextCompaction = null;
		runtime.contextCompactionInFlight = false;
		cancelQueuedWork(pi, runtime, "session started");
		runtime.continuationQueuedFor = null;
		runtime.recovery = createRecoveryState();
		runtime.activeTurnStartedAt = null;
		runtime.currentTurnToolCalls = [];
		runtime.currentTurnFileTouched = false;
		runtime.recentActions = [];
		runtime.noFileChangeTurns = 0;
		// Hide goal tools from the LLM unless we have an active goal to pursue.
		syncGoalTools(pi, runtime);
		if (runtime.goal?.status === "active" && event.reason === "reload") {
			runtime.goal = { ...runtime.goal, status: "paused", updatedAt: Date.now() };
			persist(pi, ctx, runtime.goal);
			emitGoalEvent(pi, "paused", runtime.goal, `Ⅱ goal paused after reload: ${truncateObjective(runtime.goal.objective)}
Use /goal resume to continue, or /goal clear to stop.`);
			return;
		}
		updateStatusBar(ctx, runtime);
		if (runtime.goal?.status === "active") emitGoalEvent(pi, "active", runtime.goal, `⚑ goal restored: ${truncateObjective(runtime.goal.objective)}
Use /goal pause to stop continuation, or /goal clear to remove it.`);
	});

	pi.on("turn_start", (_event, ctx) => {
		const runtime = runtimeFor(ctx);
		runtime.activeTurnStartedAt = Date.now();
		runtime.currentTurnToolCalls = [];
		runtime.currentTurnFileTouched = false;
	});

	pi.on("turn_end", (event, ctx) => {
		const runtime = runtimeFor(ctx);
		if (!runtime.goal || runtime.goal.status !== "active") return;
		const previous = runtime.goal;
		const elapsed = runtime.activeTurnStartedAt ? Math.max(0, Math.round((Date.now() - runtime.activeTurnStartedAt) / 1000)) : 0;
		runtime.activeTurnStartedAt = null;
		const tokenDelta = tokenDeltaFromUsage((event.message as any)?.usage);
		const lastTurnAction = runtime.currentTurnToolCalls.at(-1) ?? previous.lastAction;
		runtime.recentActions = [...runtime.recentActions, ...(lastTurnAction ? [lastTurnAction] : [])].slice(-MAX_RECENT_ACTIONS);
		runtime.noFileChangeTurns = runtime.currentTurnFileTouched ? 0 : runtime.noFileChangeTurns + 1;
		let next: GoalState = {
			...previous,
			tokensUsed: previous.tokensUsed + tokenDelta,
			timeUsedSeconds: previous.timeUsedSeconds + elapsed,
			turnsUsed: previous.turnsUsed + 1,
			lastAction: lastTurnAction,
			updatedAt: Date.now(),
		};

		persist(pi, ctx, next);
		if (applyRecoveryPlan(pi, ctx, next, (event as any).message)) return;

		const warning = shouldWarnForBudget(previous, next, BUDGET_WARNING_THRESHOLDS);
		if (warning != null) {
			next = { ...next, budgetWarnings: [...next.budgetWarnings, warning] };
			persist(pi, ctx, next);
			emitGoalEvent(pi, "budget_warning", next, `Goal budget warning: ${Math.round(warning * 100)}% of token budget used.`);
		}

		const reason = stopReason(next);
		if (reason) next = { ...next, status: "budget_limited", stopReason: reason };
		else if (next.checkpointEvery != null && next.turnsUsed > 0 && next.turnsUsed % next.checkpointEvery === 0) {
			next = { ...next, status: "paused", stopReason: `checkpoint after ${next.turnsUsed} turns` };
		}

		persist(pi, ctx, next);
		if (next.status === "budget_limited") {
			emitGoalEvent(pi, "budget_limited", next, undefined, { triggerTurn: true, deliverAs: "followUp" });
		} else if (next.status === "paused" && next.stopReason?.startsWith("checkpoint")) {
			emitGoalEvent(pi, "checkpoint", next, `Goal checkpoint reached after ${next.turnsUsed} turns. Review progress, then use /goal resume to continue.`);
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		const runtime = runtimeFor(ctx);
		const currentGoal = runtime.goal;
		if (!currentGoal || currentGoal.status !== "active") return;
		if (runtime.pendingContextCompaction) {
			setTimeout(() => runContextCompactionRetry(pi, ctx, runtime), 0);
			return;
		}
		if (runtime.recovery.pendingReason || ctx.hasPendingMessages()) return;
		const stuckReason = repeatedActionDetected(runtime, REPEATED_ACTION_LIMIT, NO_FILE_CHANGE_TURN_LIMIT);
		if (stuckReason) {
			const next = { ...currentGoal, status: "paused" as GoalStatus, stopReason: stuckReason, updatedAt: Date.now() };
			persist(pi, ctx, next);
			emitGoalEvent(pi, "anti_thrash", next, `Goal appears stuck; paused automatically. ${stuckReason}`);
			return;
		}
		setTimeout(() => {
			const latest = runtime.goal;
			if (!latest || latest.id !== currentGoal.id || latest.status !== "active") return;
			queueContinuation(pi, ctx, latest);
		}, 0);
	});
}
