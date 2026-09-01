#!/usr/bin/env node

/**
 * Pinned against the installed host, not against our own description of it: the
 * strategy names come out of the host's declared union and the budget is compared
 * to its declared cap, so a rename or a new strategy fails here rather than
 * silently reinstating the stall. Those two checks skip when OMP is not installed,
 * as in unit-host-compact-shape.mjs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { __test } = await import("../src/index.js");
const { localOnlyCompactionStrategy, withCompactTakeoverDeadline, COMPACT_TAKEOVER_BUDGET_MS } = __test;

const prep = (settings) => ({ settings });

// Read off the host's declared union as the complement of the local-only set.
const MODEL_SUMMARIZING = ["context-full", "handoff"];

const HOST_ROOTS = [
	process.env.OMP_AGENT_CORE,
	`${process.env.HOME}/.bun/install/global/node_modules/@oh-my-pi/pi-agent-core`,
	"/usr/local/lib/node_modules/@oh-my-pi/pi-agent-core",
];
const RUNNER_TYPES = [
	process.env.OMP_CODING_AGENT,
	`${process.env.HOME}/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent`,
	"/usr/local/lib/node_modules/@oh-my-pi/pi-coding-agent",
];

function readFirst(roots, suffix) {
	for (const root of roots.filter(Boolean)) {
		try {
			return readFileSync(`${root}${suffix}`, "utf8");
		} catch {}
	}
	return null;
}

/** The `strategy` union from the installed host's own CompactionSettings. */
function hostStrategies() {
	const src = readFirst(HOST_ROOTS, "/src/compaction/compaction.ts");
	if (!src) return null;
	const line = /^\s*strategy\?:\s*(.+);$/m.exec(src);
	assert.ok(line, "CompactionSettings no longer declares an optional `strategy` union");
	return line[1].match(/"([^"]+)"/g).map((q) => q.slice(1, -1));
}

/** The host's extension-handler cap, as the host declares it. */
function hostHandlerTimeoutMs() {
	const src = readFirst(RUNNER_TYPES, "/dist/types/extensibility/extensions/runner.d.ts");
	if (!src) return null;
	const found = /EXTENSION_HANDLER_TIMEOUT_MS\s*=\s*(\d+)/.exec(src);
	assert.ok(found, "the host no longer declares EXTENSION_HANDLER_TIMEOUT_MS");
	return Number(found[1]);
}

describe("compaction takeover is declined for strategies the host summarizes locally", () => {
	it("classifies every strategy the installed host declares", (t) => {
		const strategies = hostStrategies();
		if (!strategies) return t.skip("@oh-my-pi/pi-agent-core not installed");

		const declined = strategies.filter((s) => localOnlyCompactionStrategy(prep({ strategy: s })));
		const takenOver = strategies.filter((s) => !localOnlyCompactionStrategy(prep({ strategy: s })));

		assert.deepEqual(takenOver.sort(), [...MODEL_SUMMARIZING].sort(),
			`only strategies that summarize through the active model may be taken over; the host now declares ${strategies.join(", ")}`);
		assert.ok(declined.includes("snapcompact"),
			"snapcompact is the strategy that timed out on every compaction; it must be declined");
	});

	it("declines snapcompact, whose whole point is that it makes no model call", () => {
		assert.equal(localOnlyCompactionStrategy(prep({ strategy: "snapcompact" })), "snapcompact");
	});

	it("takes over a strategy that summarizes through the active model", () => {
		for (const strategy of MODEL_SUMMARIZING) {
			assert.equal(localOnlyCompactionStrategy(prep({ strategy })), undefined, strategy);
		}
	});

	it("takes over a host that reports no strategy at all, which is Pi", () => {
		assert.equal(localOnlyCompactionStrategy(prep({ enabled: true, keepRecentTokens: 20000 })), undefined);
	});

	it("takes over an unrecognized strategy, which may well summarize", () => {
		assert.equal(localOnlyCompactionStrategy(prep({ strategy: "some-future-llm-method" })), undefined);
		assert.equal(localOnlyCompactionStrategy(prep({ strategy: 7 })), undefined);
	});
});

describe("the takeover expires before the host kills it", () => {
	it("leaves room under the cap the installed host declares", (t) => {
		const cap = hostHandlerTimeoutMs();
		if (cap === null) return t.skip("@oh-my-pi/pi-coding-agent not installed");
		assert.ok(COMPACT_TAKEOVER_BUDGET_MS < cap,
			`budget ${COMPACT_TAKEOVER_BUDGET_MS}ms must expire before the host's ${cap}ms cap, or the host discards the result and orphans the subprocess`);
	});

	it("passes a summary that finishes in time straight through", async () => {
		let seen;
		const result = await withCompactTakeoverDeadline(undefined, (signal) => {
			seen = signal;
			return Promise.resolve({ summary: "ok" });
		});
		assert.deepEqual(result, { summary: "ok" });
		assert.equal(seen.aborted, false);
	});

	it("forwards the host's own abort", async () => {
		const host = new AbortController();
		host.abort();
		let seen;
		await withCompactTakeoverDeadline(host.signal, (signal) => {
			seen = signal;
			return Promise.resolve({ summary: "ok" });
		});
		assert.equal(seen.aborted, true);
	});

	it("aborts the Claude Code subprocess and throws once the budget is spent", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let seen;
		const pending = withCompactTakeoverDeadline(undefined, (signal) => {
			seen = signal;
			return new Promise(() => {});
		});
		t.mock.timers.tick(COMPACT_TAKEOVER_BUDGET_MS);
		await assert.rejects(pending, /extension-handler budget/);
		assert.equal(seen.aborted, true,
			"an expired takeover must abort its own summary; the host never does, so it would run on billing a discarded result");
	});
});
