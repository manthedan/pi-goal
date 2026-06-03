export type BudgetWarningGoal = {
	tokenBudget: number | null;
	tokensUsed: number;
	budgetWarnings: number[];
};

export type StopReasonGoal = {
	tokenBudget: number | null;
	tokensUsed: number;
	maxTurns: number | null;
	turnsUsed: number;
	maxMinutes: number | null;
	timeUsedSeconds: number;
};

export type ThrashRuntime = {
	recentActions: string[];
	noFileChangeTurns: number;
};

export function shouldWarnForBudget(goal: BudgetWarningGoal, next: BudgetWarningGoal, thresholds: readonly number[]): number | null {
	if (!next.tokenBudget) return null;
	const ratio = next.tokensUsed / next.tokenBudget;
	for (const threshold of thresholds) {
		if (ratio >= threshold && !goal.budgetWarnings.includes(threshold)) return threshold;
	}
	return null;
}

export function stopReason(next: StopReasonGoal): string | null {
	if (next.tokenBudget != null && next.tokensUsed >= next.tokenBudget) return "token budget reached";
	if (next.maxTurns != null && next.turnsUsed >= next.maxTurns) return "max turns reached";
	if (next.maxMinutes != null && next.timeUsedSeconds >= next.maxMinutes * 60) return "max minutes reached";
	return null;
}

export function repeatedActionDetected(runtime: ThrashRuntime, repeatedActionLimit: number, noFileChangeTurnLimit: number): string | null {
	if (runtime.recentActions.length >= repeatedActionLimit) {
		const recent = runtime.recentActions.slice(-repeatedActionLimit);
		if (recent.every((action) => action === recent[0])) return `Repeated the same action ${repeatedActionLimit} times: ${recent[0]}`;
	}
	if (runtime.noFileChangeTurns >= noFileChangeTurnLimit) return `No file-changing tools observed for ${runtime.noFileChangeTurns} consecutive turns.`;
	return null;
}
