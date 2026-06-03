export type RecoveryState = {
	signature: string | null;
	transientAttempts: number;
	contextOverflowAttempts: number;
	pendingReason: string | null;
};

export type RecoveryPlan =
	| { type: "none" }
	| { type: "retry"; reason: string; delayMs: number }
	| { type: "pause"; reason: string };

export const MAX_TRANSIENT_RETRIES = 2;
export const MAX_CONTEXT_OVERFLOW_RETRIES = 1;
export const TRANSIENT_RETRY_DELAYS_MS = [2_000, 8_000] as const;

export function createRecoveryState(): RecoveryState {
	return { signature: null, transientAttempts: 0, contextOverflowAttempts: 0, pendingReason: null };
}

export function resetRecoveryState(state: RecoveryState) {
	state.signature = null;
	state.transientAttempts = 0;
	state.contextOverflowAttempts = 0;
	state.pendingReason = null;
}

export function isAssistantErrorMessage(message: any): boolean {
	return message?.role === "assistant" && message?.stopReason === "error";
}

export function isSuccessfulAssistantMessage(message: any): boolean {
	return message?.role === "assistant" && message?.stopReason !== "error" && message?.stopReason !== "aborted";
}

export function isContextOverflowError(errorMessage: string | undefined): boolean {
	return /context.?overflow|context.?window|maximum context|context length|too many tokens|tokens exceed|input is too long|request too large/i.test(errorMessage ?? "");
}

function isNonRetryableProviderLimitError(errorMessage: string): boolean {
	return /usage limit|monthly usage|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(errorMessage);
}

export function isRetryableTransientError(errorMessage: string | undefined): boolean {
	if (!errorMessage || isContextOverflowError(errorMessage) || isNonRetryableProviderLimitError(errorMessage)) return false;
	return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|fetch failed|upstream|socket hang up|stream ended|timed? out|timeout|terminated/i.test(errorMessage);
}

function normalizeSignature(errorMessage: string | undefined): string {
	const firstLine = (errorMessage ?? "unknown_error").trim().split("\n")[0] ?? "unknown_error";
	return firstLine
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
		.replace(/\breq[_-][a-z0-9-]+\b/gi, "req_<id>")
		.replace(/\b\d{4,}\b/g, "<n>")
		.slice(0, 180);
}

export function planRecoveryForAssistantMessage(state: RecoveryState, message: any): RecoveryPlan {
	if (!isAssistantErrorMessage(message)) {
		if (isSuccessfulAssistantMessage(message)) resetRecoveryState(state);
		return { type: "none" };
	}

	const errorMessage = String(message?.errorMessage ?? "");
	if (isContextOverflowError(errorMessage)) {
		state.contextOverflowAttempts += 1;
		state.pendingReason = "context overflow";
		if (state.contextOverflowAttempts > MAX_CONTEXT_OVERFLOW_RETRIES) {
			return { type: "pause", reason: "context overflow recovery failed after repeated attempts" };
		}
		return { type: "retry", reason: "context overflow; retrying after host compaction/recovery", delayMs: 1_000 };
	}

	const signature = normalizeSignature(errorMessage);
	if (state.signature !== signature) {
		state.signature = signature;
		state.transientAttempts = 0;
	}

	if (!isRetryableTransientError(errorMessage)) {
		return { type: "pause", reason: `non-retryable provider error (${signature})` };
	}

	state.transientAttempts += 1;
	state.pendingReason = `provider error (${signature})`;
	if (state.transientAttempts > MAX_TRANSIENT_RETRIES) {
		return { type: "pause", reason: `provider error retry limit reached (${signature})` };
	}
	return {
		type: "retry",
		reason: `transient provider error (${signature}); retry ${state.transientAttempts}/${MAX_TRANSIENT_RETRIES}`,
		delayMs: TRANSIENT_RETRY_DELAYS_MS[state.transientAttempts - 1] ?? TRANSIENT_RETRY_DELAYS_MS.at(-1)!,
	};
}
