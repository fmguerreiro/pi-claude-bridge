/**
 * Stream resilience: failure classification (#58), the one-shot transient retry
 * (#43), and the idle stall watchdog (#35).
 *
 * The #58 assertions are checked against pi-ai's *own* classifier
 * (`isRetryableAssistantError`), not against a copy of its regexes: the whole
 * point of the fix is that pi's fallback machinery — which reads nothing but
 * `stopReason` + `errorMessage` off the final AssistantMessage — recognizes the
 * failure. Each test therefore also asserts that the raw Claude Code wording does
 * NOT pass that predicate, so the test fails if the bug is ever reintroduced by
 * dropping the classification step.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { QueryContext } from "../src/query-state.js";
import {
	classifyFailure,
	decideRetry,
	StreamMonitor,
	StreamStalledError,
	stallTimeoutMs,
	DEFAULT_STALL_TIMEOUT_MS,
} from "../src/stream-resilience.js";

const { __test } = await import("../src/index.js");

const model = { api: "anthropic-messages", provider: "anthropic", id: "claude-opus-4-5" };

// The two failures the field reports quote verbatim.
const LIMIT_TEXT = "You've hit your limit · resets 9am (Europe/Paris)";
const OVERLOAD_TEXT = "Server is temporarily limiting requests (not your usage limit): Rate limited";

/** What pi sees at the end of a failed turn. */
const asPiMessage = (errorMessage) => ({ role: "assistant", stopReason: "error", errorMessage });

/** A QueryContext wired to collect pi-side events, as the provider path builds it. */
function harness({ idleMs = 0 } = {}) {
	const events = [];
	const c = new QueryContext();
	c.currentPiStream = { push: (e) => events.push(e), end: () => events.push({ type: "end" }) };
	c.resetTurnState(model);
	c.streamMonitor = new StreamMonitor({ idleMs, hasPendingWork: () => false, onStall: () => {} });
	return { c, events };
}

function sleep(ms) {
	const { promise, resolve } = Promise.withResolvers();
	setTimeout(resolve, ms);
	return promise;
}

async function* streamOf(messages) {
	for (const m of messages) yield m;
}

describe("#58 subscription limit reaches pi as a rate-limit-class error", () => {
	it("the raw Claude Code wording is what pi cannot classify", () => {
		// The bug, pinned: this is why fallbackModels never fired.
		assert.equal(isRetryableAssistantError(asPiMessage(LIMIT_TEXT)), false);
		assert.equal(isRetryableAssistantError(asPiMessage(`Claude Code returned an error result: ${LIMIT_TEXT}`)), false);
	});

	it("limit text classifies rate-limit and passes pi's predicate", () => {
		const classified = classifyFailure(LIMIT_TEXT);
		assert.equal(classified.kind, "rate-limit");
		assert.match(classified.message, /rate limit/i);
		assert.match(classified.message, new RegExp(LIMIT_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(isRetryableAssistantError(asPiMessage(classified.message)), true);
	});

	it("a rejected rate-limit event reclassifies an otherwise opaque failure", () => {
		const opaque = "Claude Code failed: error_during_execution";
		assert.equal(classifyFailure(opaque).kind, "fatal");
		const classified = classifyFailure(opaque, true);
		assert.equal(classified.kind, "rate-limit");
		assert.equal(isRetryableAssistantError(asPiMessage(classified.message)), true);
	});

	it("consumeQuery turns a rejected event + error result into the typed error", async () => {
		const { c } = harness();
		await __test.consumeQuery(streamOf([
			{ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "overage", overageStatus: "rejected", resetsAt: 0 } },
			{ type: "result", subtype: "success", is_error: true, result: LIMIT_TEXT },
		]), new Map(), model, () => false, c, []);

		assert.equal(c.turnOutput.stopReason, "error");
		assert.equal(c.streamMonitor.rateLimitRejected, true);
		assert.equal(isRetryableAssistantError(asPiMessage(c.turnOutput.errorMessage)), true);
	});

	it("an allowed overage event leaves classification to the text", async () => {
		// The live event the bridge actually sees on a healthy account.
		const { c } = harness();
		await __test.consumeQuery(streamOf([
			{ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "overage", overageStatus: "allowed" } },
			{ type: "result", subtype: "success", is_error: true, result: "Claude Code failed: error_during_execution" },
		]), new Map(), model, () => false, c, []);

		assert.equal(c.streamMonitor.rateLimitRejected, false);
		assert.equal(c.turnOutput.errorMessage, "Claude Code failed: error_during_execution");
	});

	it("keeps a detail that would defeat pi's non-retryable patterns out of the message", () => {
		// pi-ai checks its non-retryable patterns first, so a detail carrying one
		// would silence the fallback the classification exists to trigger.
		const detail = "You've hit your limit · enable available balance to continue";
		assert.equal(isRetryableAssistantError(asPiMessage(detail)), false);
		const classified = classifyFailure(detail);
		assert.equal(classified.kind, "rate-limit");
		assert.doesNotMatch(classified.message, /available balance/);
		assert.equal(isRetryableAssistantError(asPiMessage(classified.message)), true);
	});

	it("reports a billing or quota wall verbatim, as pi does", () => {
		// pi-ai treats these as non-retryable no matter how we word them, so there
		// is nothing to gain by dressing one up as rate-limit class.
		const classified = classifyFailure("You've hit your limit — check billing");
		assert.equal(classified.kind, "fatal");
		assert.equal(classified.message, "You've hit your limit — check billing");
	});

	it("never retries a real subscription limit", () => {
		const decision = decideRetry({ failure: new Error(LIMIT_TEXT), outputStarted: false, retriesUsed: 0 });
		assert.equal(decision.kind, "rate-limit");
		assert.equal(decision.retry, false);
	});
});

describe("#43 one retry for a transient overload", () => {
	it("classifies the 529 wording transient despite it naming the usage limit", () => {
		const classified = classifyFailure(OVERLOAD_TEXT);
		assert.equal(classified.kind, "transient");
		assert.equal(classified.message, OVERLOAD_TEXT);
	});

	it("retries exactly once before any output, then succeeds", async () => {
		const { c, events } = harness();
		let starts = 0;
		let restarts = 0;
		const attempt = {
			current: () => {
				starts++;
				if (starts === 1) {
					return (async function* () { throw new Error(OVERLOAD_TEXT); })();
				}
				return streamOf([{ type: "result", subtype: "success", result: "recovered" }]);
			},
			restart: () => { restarts++; },
			abort: () => {},
		};

		const outcome = await __test.consumeQueryWithRetry(attempt, new Map(), model, () => false, c, []);

		assert.deepEqual(outcome, { capturedSessionId: undefined });
		assert.equal(starts, 2, "one retry means exactly two attempts");
		assert.equal(restarts, 1, "the replacement query must be started through restart()");
		assert.equal(c.turnOutput.stopReason, "stop");
		assert.equal(c.turnOutput.errorMessage, undefined, "the retried turn must not carry attempt 1's failure");
		assert.deepEqual(events.filter((e) => e.type === "text_end").map((e) => e.content), ["recovered"]);
	});

	it("does not retry a second time when the replacement also fails", async () => {
		const { c } = harness();
		let starts = 0;
		const attempt = {
			current: () => {
				starts++;
				return (async function* () { throw new Error(OVERLOAD_TEXT); })();
			},
			restart: () => {},
			abort: () => {},
		};

		await assert.rejects(
			__test.consumeQueryWithRetry(attempt, new Map(), model, () => false, c, []),
			/temporarily limiting requests/,
		);
		assert.equal(starts, 2, "the retry budget is one");
	});

	it("does not retry once output has started", async () => {
		const { c, events } = harness();
		let starts = 0;
		const attempt = {
			current: () => {
				starts++;
				return (async function* () {
					yield { type: "assistant", message: { content: [{ type: "text", text: "partial answer" }], stop_reason: "end_turn" } };
					throw new Error(OVERLOAD_TEXT);
				})();
			},
			restart: () => { assert.fail("must not restart after output"); },
			abort: () => {},
		};

		await assert.rejects(
			__test.consumeQueryWithRetry(attempt, new Map(), model, () => false, c, []),
			/temporarily limiting requests/,
		);
		assert.equal(starts, 1);
		// Retrying here would have duplicated this text in pi's transcript.
		assert.deepEqual(events.filter((e) => e.type === "text_end").map((e) => e.content), ["partial answer"]);
	});

	it("returns a non-retryable error result through the normal completion path", async () => {
		// An error *result* does not reject, and must keep leaving that way: the
		// provider's catch path wipes the shared session outright.
		const { c } = harness();
		let starts = 0;
		const attempt = {
			current: () => { starts++; return streamOf([{ type: "result", subtype: "success", is_error: true, result: LIMIT_TEXT }]); },
			restart: () => { assert.fail("a subscription limit must never be retried"); },
			abort: () => {},
		};

		const outcome = await __test.consumeQueryWithRetry(attempt, new Map(), model, () => false, c, []);
		assert.equal(starts, 1);
		assert.deepEqual(outcome, { capturedSessionId: undefined });
		assert.equal(c.turnOutput.stopReason, "error");
		assert.equal(isRetryableAssistantError(asPiMessage(c.turnOutput.errorMessage)), true);
	});

	it("retries a transient error result, not just a rejection", async () => {
		const { c } = harness();
		let starts = 0;
		const attempt = {
			current: () => {
				starts++;
				if (starts === 1) return streamOf([{ type: "result", subtype: "success", is_error: true, result: OVERLOAD_TEXT }]);
				return streamOf([{ type: "result", subtype: "success", result: "recovered" }]);
			},
			restart: () => {},
			abort: () => {},
		};

		await __test.consumeQueryWithRetry(attempt, new Map(), model, () => false, c, []);
		assert.equal(starts, 2);
		assert.equal(c.turnOutput.stopReason, "stop");
	});

	it("never retries auth, quota, payment or permission failures", () => {
		const never = [
			"Invalid API key · please run /login",
			"401 Unauthorized",
			"Credit balance is too low",
			"quota exceeded for this project",
			"Your billing account is inactive",
			"permission denied: cannot spawn Claude Code",
		];
		for (const text of never) {
			const decision = decideRetry({ failure: new Error(text), outputStarted: false, retriesUsed: 0 });
			assert.equal(decision.retry, false, `must not retry: ${text}`);
			assert.equal(decision.kind, "fatal", `must classify fatal: ${text}`);
			assert.equal(decision.message, text, "a fatal failure is reported verbatim");
		}
	});

	it("does not retry an aborted turn", () => {
		const decision = decideRetry({ failure: new Error(OVERLOAD_TEXT), outputStarted: false, retriesUsed: 0, aborted: true });
		assert.equal(decision.retry, false);
		assert.equal(decision.reason, "aborted");
	});
});

describe("#35 idle stall watchdog", () => {
	it("fires when the stream is idle with no pending tool call", async () => {
		const stalls = [];
		const monitor = new StreamMonitor({ idleMs: 20, hasPendingWork: () => false, onStall: (e) => stalls.push(e) });
		monitor.arm();
		await sleep(80);

		assert.equal(stalls.length, 1);
		assert.ok(stalls[0] instanceof StreamStalledError);
		assert.equal(monitor.stalled, true);
		// Must still read as retryable one level up, in pi's own classifier.
		assert.equal(isRetryableAssistantError(asPiMessage(stalls[0].message)), true);
		monitor.stop();
	});

	it("does not fire while a tool call is in flight, and re-arms after it lands", async () => {
		const stalls = [];
		let pending = true;
		const monitor = new StreamMonitor({ idleMs: 20, hasPendingWork: () => pending, onStall: (e) => stalls.push(e) });
		monitor.arm();
		await sleep(100);
		assert.equal(stalls.length, 0, "a long tool call is not a stalled stream");
		assert.equal(monitor.stalled, false);

		// The issue's sketch returned without re-arming, which left the watchdog
		// dead for the rest of the query.
		pending = false;
		await sleep(80);
		assert.equal(stalls.length, 1);
		monitor.stop();
	});

	it("every SDK event re-arms the timer", async () => {
		const stalls = [];
		const monitor = new StreamMonitor({ idleMs: 40, hasPendingWork: () => false, onStall: (e) => stalls.push(e) });
		monitor.arm();
		for (let i = 0; i < 5; i++) {
			await sleep(15);
			monitor.onSdkEvent("stream_event");
		}
		assert.equal(stalls.length, 0, "75ms of activity in 40ms windows must not stall");
		monitor.stop();
	});

	it("a result disarms it, so the generator's wind-down cannot stall", async () => {
		const stalls = [];
		const monitor = new StreamMonitor({ idleMs: 20, hasPendingWork: () => false, onStall: (e) => stalls.push(e) });
		monitor.arm();
		monitor.onSdkEvent("result");
		await sleep(80);
		assert.equal(stalls.length, 0);
	});

	it("consumeQuery re-arms on every message, including non-content frames", async () => {
		const seen = [];
		const { c } = harness();
		c.streamMonitor = new StreamMonitor({ idleMs: 0, hasPendingWork: () => false, onStall: () => {} });
		const original = c.streamMonitor.onSdkEvent.bind(c.streamMonitor);
		c.streamMonitor.onSdkEvent = (type) => { seen.push(type); original(type); };

		await __test.consumeQuery(streamOf([
			{ type: "system", subtype: "init", session_id: "s1" },
			{ type: "system", subtype: "status" },
			{ type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
			{ type: "result", subtype: "success", result: "done" },
		]), new Map(), model, () => false, c, []);

		assert.deepEqual(seen, ["system", "system", "rate_limit_event", "result"]);
	});

	it("stops the turn on a stall instead of reporting a clean end_turn", async () => {
		const { c } = harness();
		let aborted = false;
		// Stands in for the provider's own wiring: the watchdog marks the turn and
		// aborts, which makes the generator return rather than throw.
		const gate = Promise.withResolvers();
		const monitor = new StreamMonitor({
			idleMs: 20,
			hasPendingWork: () => c.pendingToolCalls.size > 0,
			onStall: (error) => {
				c.turnOutput.stopReason = "error";
				c.turnOutput.errorMessage = error.message;
				aborted = true;
				gate.resolve();
			},
		});
		c.streamMonitor = monitor;
		monitor.arm();
		// The watchdog's own timer is unref'd — it must never be the reason pi stays
		// alive — so nothing here would keep the loop running while we wait for it.
		const keepAlive = setInterval(() => {}, 5);

		await __test.consumeQuery((async function* () {
			yield { type: "system", subtype: "init", session_id: "s1" };
			await gate.promise;
		})(), new Map(), model, () => false, c, []);
		clearInterval(keepAlive);

		assert.equal(aborted, true);
		assert.equal(monitor.stalled, true);
		assert.equal(c.turnOutput.stopReason, "error");
		assert.equal(isRetryableAssistantError(asPiMessage(c.turnOutput.errorMessage)), true);
		monitor.stop();
	});

	it("a pending tool call keeps the same stream alive", async () => {
		const { c } = harness();
		const stalls = [];
		const monitor = new StreamMonitor({ idleMs: 20, hasPendingWork: () => c.pendingToolCalls.size > 0, onStall: (e) => stalls.push(e) });
		c.streamMonitor = monitor;
		c.pendingToolCalls.set("call-1", { toolName: "bash", resolve: () => {} });
		monitor.arm();
		await sleep(100);
		assert.equal(stalls.length, 0);
		monitor.stop();
	});

	it("the timeout is five minutes by default and disablable", () => {
		assert.equal(stallTimeoutMs({}), DEFAULT_STALL_TIMEOUT_MS);
		assert.equal(DEFAULT_STALL_TIMEOUT_MS, 300_000);
		assert.equal(stallTimeoutMs({ CLAUDE_BRIDGE_STALL_TIMEOUT_MS: "1500" }), 1500);
		assert.equal(stallTimeoutMs({ CLAUDE_BRIDGE_STALL_TIMEOUT_MS: "0" }), 0);
		// Junk must not arm a zero-delay timer that would kill every turn.
		assert.equal(stallTimeoutMs({ CLAUDE_BRIDGE_STALL_TIMEOUT_MS: "soon" }), DEFAULT_STALL_TIMEOUT_MS);
	});

	it("a stall surfaces as retryable, so #43's policy restarts the query once", async () => {
		// The wrapper reads the budget per attempt, so shrinking it here exercises the
		// real watchdog rather than a hand-built monitor.
		const previous = process.env.CLAUDE_BRIDGE_STALL_TIMEOUT_MS;
		process.env.CLAUDE_BRIDGE_STALL_TIMEOUT_MS = "25";
		const keepAlive = setInterval(() => {}, 5);
		try {
			const { c, events } = harness();
			let starts = 0;
			let restarts = 0;
			let closed = 0;
			const halfOpen = Promise.withResolvers();
			const attempt = {
				current: () => {
					starts++;
					if (starts === 1) {
						// Half-open: one frame, then events stop and nothing ever throws.
						return (async function* () {
							yield { type: "system", subtype: "init", session_id: "s1" };
							await halfOpen.promise;
						})();
					}
					return streamOf([{ type: "result", subtype: "success", result: "recovered" }]);
				},
				restart: () => { restarts++; },
				// What requestAbort does to a live query: closing it makes the
				// generator return instead of throwing.
				abort: () => { closed++; halfOpen.resolve(); },
			};

			await __test.consumeQueryWithRetry(attempt, new Map(), model, () => false, c, []);

			assert.equal(closed, 1, "the stalled query must be aborted");
			assert.equal(starts, 2);
			assert.equal(restarts, 1);
			assert.equal(c.turnOutput.stopReason, "stop");
			assert.deepEqual(events.filter((e) => e.type === "text_end").map((e) => e.content), ["recovered"]);
		} finally {
			clearInterval(keepAlive);
			if (previous === undefined) delete process.env.CLAUDE_BRIDGE_STALL_TIMEOUT_MS;
			else process.env.CLAUDE_BRIDGE_STALL_TIMEOUT_MS = previous;
		}
	});
});
