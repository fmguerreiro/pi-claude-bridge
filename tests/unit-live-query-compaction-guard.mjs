#!/usr/bin/env node

/**
 * A history rewrite made while a Claude Code query is in flight cannot reach the
 * wire, so `session_before_compact` must cancel instead of letting the host
 * spend a summarization on it.
 *
 * The host premise is pinned against the installed host rather than restated,
 * the way unit-compact-takeover-guard.mjs pins the strategy union: if it ever
 * stops flooring the trigger at the stored estimate, a mid-turn compaction
 * becomes observable to it and this decline is no longer needed.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { default: activate, __test } = await import("../src/index.js");
const {
	markQueryLive,
	markQuerySettled,
	queryIsLive,
	resetSharedSession,
	setSharedOwner,
	setSharedSession,
	bumpHistoryEpoch,
	historyEpoch,
	ACTIVE_STREAM_SIMPLE_KEY,
} = __test;

const OWNER = "host-session-owner";
const OTHER = "host-session-other";

/** The registered `session_before_compact` handler, from a real activate(). */
function beforeCompactHandler() {
	const handlers = new Map();
	activate({
		on: (event, handler) => handlers.set(event, handler),
		registerProvider: () => {},
	});
	const handler = handlers.get("session_before_compact");
	assert.ok(handler, "activate() must register session_before_compact");
	return handler;
}

/** A compact event the host would emit for `sessionId`, with a local strategy
 *  (snapcompact) so the no-live-query case has a known non-cancel answer. */
function compactCall(sessionId) {
	return [
		{
			preparation: { settings: { strategy: "snapcompact" }, messagesToSummarize: [], turnPrefixMessages: [] },
			branchEntries: [],
			customInstructions: undefined,
			signal: new AbortController().signal,
			reason: "threshold",
			willRetry: false,
		},
		{
			model: { baseUrl: "claude-bridge", id: "claude-haiku-4-5" },
			sessionManager: { getSessionId: () => sessionId },
		},
	];
}

beforeEach(() => {
	resetSharedSession();
	delete globalThis[ACTIVE_STREAM_SIMPLE_KEY];
});

describe("compaction is declined while Claude Code owns the conversation", () => {
	it("cancels when a query is live for the compacting session", async () => {
		const handler = beforeCompactHandler();
		markQueryLive(OWNER);
		assert.deepEqual(await handler(...compactCall(OWNER)), { cancel: true });
	});

	it("does not cancel once that query settles", async () => {
		const handler = beforeCompactHandler();
		markQueryLive(OWNER);
		markQuerySettled(OWNER);
		const result = await handler(...compactCall(OWNER));
		assert.notEqual(
			result?.cancel,
			true,
			"a pre-prompt compaction runs with no query live and is the one that takes effect",
		);
	});

	it("does not cancel one session's compaction for another session's live query", async () => {
		const handler = beforeCompactHandler();
		markQueryLive(OTHER);
		const result = await handler(...compactCall(OWNER));
		assert.notEqual(result?.cancel, true, "a subagent lane's turn must not block the parent's compaction");
	});

	it("leaves a live query in place until every holder settles", () => {
		// A retry re-registers under the same id while the first is still counted.
		markQueryLive(OWNER);
		markQueryLive(OWNER);
		markQuerySettled(OWNER);
		assert.equal(queryIsLive(OWNER), true);
		markQuerySettled(OWNER);
		assert.equal(queryIsLive(OWNER), false);
	});

	it("reports no live query for a session the host never named", () => {
		assert.equal(queryIsLive(undefined), false);
	});

	it("does not strand a live entry across a reload", async () => {
		// /reload keeps the Symbol.for map but abandons the decrementing closure,
		// which would cancel this session's compaction forever.
		const handlers = new Map();
		activate({
			on: (event, handler) => handlers.set(event, handler),
			registerProvider: () => {},
		});
		markQueryLive(OWNER);
		handlers.get("session_shutdown")({}, { ui: null });
		assert.equal(queryIsLive(OWNER), false, "session_shutdown must release every live entry");

		const result = await handlers.get("session_before_compact")(...compactCall(OWNER));
		assert.notEqual(result?.cancel, true);
	});
});

describe("the host premise: a stored-history cut cannot lower the trigger", () => {
	const CORE_ROOTS = [
		process.env.OMP_AGENT_CORE,
		`${process.env.HOME}/.bun/install/global/node_modules/@oh-my-pi/pi-agent-core`,
		"/usr/local/lib/node_modules/@oh-my-pi/pi-agent-core",
	];

	function hostCompactionSource() {
		for (const root of CORE_ROOTS.filter(Boolean)) {
			try {
				return readFileSync(`${root}/src/compaction/compaction.ts`, "utf8");
			} catch {}
		}
		return null;
	}

	it("floors the compaction decision at the stored estimate", (t) => {
		const source = hostCompactionSource();
		if (!source) return t.skip("host pi-agent-core not installed");
		const body = source.slice(source.indexOf("export function compactionContextTokens"));
		const signature = body.slice(0, body.indexOf("}") + 1);
		assert.match(
			signature,
			/Math\.max/,
			"compactionContextTokens no longer takes a maximum, so a mid-turn cut may now be observable to the host "
			+ "and the session_before_compact decline should be re-derived",
		);
	});
});

describe("an unattributed history-epoch bump reaches a reader with a known owner", () => {
	it("moves the epoch a session-keyed reader sees", () => {
		// The silent loss: the bump keys on "", the reader reads one owner's key.
		setSharedOwner(OWNER);
		const before = historyEpoch();
		bumpHistoryEpoch(undefined, "test: rewrite with no session id");
		assert.notEqual(historyEpoch(), before, "an unattributed bump must invalidate every reader");
	});

	it("still moves when the owner's own count is behind the unattributed one", () => {
		// The regression a maximum would reintroduce.
		setSharedOwner(OWNER);
		bumpHistoryEpoch(undefined, "test: first unattributed");
		bumpHistoryEpoch(undefined, "test: second unattributed");
		const before = historyEpoch();
		bumpHistoryEpoch(OWNER, "test: attributed");
		assert.notEqual(historyEpoch(), before, "an attributed bump must invalidate even when behind");
	});

	it("keeps a rebuilt session's recorded epoch matching until something moves", () => {
		setSharedOwner(OWNER);
		setSharedSession({ sessionId: "cc-session", cursor: 3, cwd: "/tmp", epoch: historyEpoch() });
		assert.equal(historyEpoch(), 0, "a conversation nothing rewrote must not force a rebuild");
	});
});
