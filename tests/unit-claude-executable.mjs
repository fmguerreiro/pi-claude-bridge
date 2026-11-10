import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants as fsConstants } from "node:fs";
import { resolveClaudeExecutableCommand } from "../src/claude-executable.js";

describe("resolveClaudeExecutableCommand", () => {
	it("spawns a native-binary override directly, without touching the bundled binary", () => {
		assert.deepEqual(resolveClaudeExecutableCommand("/opt/nix/bin/claude"), ["/opt/nix/bin/claude"]);
	});

	it("wraps a script override in the current runtime, matching how query() launches it", () => {
		const runner = process.versions.bun !== undefined ? "bun" : "node";
		assert.deepEqual(resolveClaudeExecutableCommand("/repo/sdk/cli.js"), [runner, "/repo/sdk/cli.js"]);
		assert.deepEqual(resolveClaudeExecutableCommand("/repo/sdk/cli.mjs"), [runner, "/repo/sdk/cli.mjs"]);
	});

	it("falls back to the bundled native binary when there is no override", () => {
		const [resolved, ...rest] = resolveClaudeExecutableCommand(undefined) ?? [];
		assert.ok(resolved, "expected a bundled claude binary to resolve on this platform");
		assert.deepEqual(rest, [], "the bundled binary is native, so query() spawns it directly");
		assert.ok(resolved.endsWith(process.platform === "win32" ? "claude.exe" : "claude"));
		accessSync(resolved, fsConstants.X_OK);
	});

	it("resolves to a path inside the installed @anthropic-ai/claude-agent-sdk-* package for this host", () => {
		const [resolved] = resolveClaudeExecutableCommand(undefined);
		assert.match(resolved, new RegExp(`@anthropic-ai[\\\\/]claude-agent-sdk-${process.platform}-${process.arch}`));
	});

	it("returns undefined rather than throwing when no native package matches this host", () => {
		const originalArch = Object.getOwnPropertyDescriptor(process, "arch");
		Object.defineProperty(process, "arch", { value: "riscv64", configurable: true });
		try {
			assert.equal(resolveClaudeExecutableCommand(undefined), undefined);
		} finally {
			Object.defineProperty(process, "arch", originalArch);
		}
	});
});
