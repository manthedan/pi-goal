import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export function sessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionFile?.() ?? ctx.sessionManager.getSessionId?.() ?? ctx.cwd;
}
