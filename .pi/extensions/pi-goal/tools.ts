import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export const GOAL_TOOL_NAMES = ["get_goal", "update_goal"];

type ToolGoal = {
	status: "active" | "paused" | "budget_limited" | "complete";
	tokenBudget: number | null;
	tokensUsed: number;
	updatedAt: number;
};

type RegisterGoalToolsDeps<Goal extends ToolGoal> = {
	runtimeFor: (ctx: ExtensionContext) => { goal: Goal | null };
	persist: (pi: ExtensionAPI, ctx: ExtensionContext, next: Goal | null) => void;
	emitComplete: (goal: Goal) => void;
};

export function registerGoalTools<Goal extends ToolGoal>(pi: ExtensionAPI, deps: RegisterGoalToolsDeps<Goal>) {
	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Read the current active thread goal, if one exists.",
		promptSnippet: "Read the current pi-goal objective and remaining budget while pursuing it",
		promptGuidelines: [
			"Only call get_goal when you actually need the current objective or remaining budget; the continuation prompt already injects them.",
		],
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false,
		} as any,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const goal = deps.runtimeFor(ctx).goal;
			return { content: [{ type: "text", text: JSON.stringify({ goal }, null, 2) }], details: { goal } };
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description: "Mark the current thread goal complete. This tool only accepts status=complete.",
		promptSnippet: "Mark the current goal complete after a strict completion audit",
		promptGuidelines: [
			"Use update_goal only when the current pi-goal objective is fully achieved and verified against concrete evidence.",
			"Do not use update_goal to pause, resume, abandon, or budget-limit a goal.",
		],
		parameters: {
			type: "object",
			properties: { status: { type: "string", enum: ["complete"], description: "Only complete is accepted." } },
			required: ["status"],
			additionalProperties: false,
		} as any,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.status !== "complete") return { content: [{ type: "text", text: "update_goal only accepts status=complete." }], isError: true };
			const runtime = deps.runtimeFor(ctx);
			if (!runtime.goal) return { content: [{ type: "text", text: "No goal is set." }], isError: true };
			const next = { ...runtime.goal, status: "complete" as const, updatedAt: Date.now() };
			deps.persist(pi, ctx, next);
			deps.emitComplete(next);
			return {
				content: [{ type: "text", text: JSON.stringify({ goal: next, remainingTokens: next.tokenBudget == null ? null : Math.max(0, next.tokenBudget - next.tokensUsed) }, null, 2) }],
				details: { goal: next },
			};
		},
	});
}
