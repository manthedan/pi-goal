import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const roadmap = readFileSync(new URL("../ROADMAP.md", import.meta.url), "utf8");
const extension = readFileSync(new URL("../.pi/extensions/pi-goal/index.ts", import.meta.url), "utf8");

describe("package manifest", () => {
	it("declares the pi extension and packaged docs", () => {
		assert.deepEqual(pkg.pi.extensions, [".pi/extensions/pi-goal"]);
		assert.ok(pkg.files.includes(".pi/"));
		assert.ok(pkg.files.includes("README.md"));
		assert.ok(pkg.files.includes("ROADMAP.md"));
	});
});

describe("documented goal controls", () => {
	it("documents all hardened loop controls", () => {
		for (const token of ["--tokens", "--max-turns", "--max-minutes", "--checkpoint", "/goal export", "/goal import"]) {
			assert.match(readme, new RegExp(token.replace(/[/-]/g, "\\$&")));
		}
	});

	it("keeps deferred ideas in the roadmap", () => {
		for (const heading of ["Interrupt behavior", "Goal plan / task list", "Goal templates"]) {
			assert.match(roadmap, new RegExp(heading));
		}
	});
});

describe("extension implementation", () => {
	it("contains safeguards for continuation, budgets, checkpoints, evidence, and anti-thrash", () => {
		for (const symbol of [
			"canQueueContinuation",
			"sessionKey",
			"maxTurns",
			"maxMinutes",
			"checkpointEvery",
			"evidenceLedger",
			"budget_warning",
			"anti_thrash",
			"exportGoalMarkdown",
			"parseImportedGoal",
		]) {
			assert.match(extension, new RegExp(symbol));
		}
	});

	it("loads in pi", () => {
		assert.doesNotThrow(() => {
			execFileSync("npm", ["run", "check", "--silent"], {
				cwd: new URL("..", import.meta.url),
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		});
	});
});
