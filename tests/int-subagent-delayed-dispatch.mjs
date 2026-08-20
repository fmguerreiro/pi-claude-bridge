#!/usr/bin/env node
// Does the foreign-conversation guard cover a *subagent*, not just a side agent?
//
// `foreignConversation` is `promptCapture.sharesSubstantialPrefix === false`, and
// prompt-capture sets that field only on a pass-through capture — a prompt this
// bridge never recorded. OMP's advisor, title generator and idle recap qualify.
// A subagent does not: its prompt embeds the parent's assembled prompt, so it
// resolves through the `inherited` route with `sharesSubstantialPrefix` undefined
// and is never flagged foreign. If its provider call lands after the parent's
// stream closed it is also not reentrant, which leaves it taking the ordinary
// REUSE/REBUILD paths against the parent's session.
//
// Runs on OMP, not pi, and that is load-bearing: pi-subagents rebuilds the child
// prompt, so the child dies in prompt-capture before making a model call and
// int-subagent-rpiv-codebase-locator.mjs passes without a subagent ever running.
//
// OMP's task tool returns as soon as children are spawned, so the parent's turn
// ends while a child is still working — the delayed dispatch this exercises. The
// codeword is the user-visible oracle: it is in the parent's history and nowhere
// in the child's, so answering with the subagent's output means the parent was
// handed the child's transcript.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";
const TEST_TIMEOUT = 240_000;
const CODEWORD = "ZEBRA-47-QUILL";
const CHILD_TASK = "Reply with exactly SUBAGENT-COUNTED-FOUR and nothing else.";
// OMP wraps every prompt in <system-reminder>/<host-steer>, so a logged prompt
// preview cannot attribute a query to the child. These read the decisions instead.
const ISOLATED = /path=(foreign-clean-start|foreign-import)/;
const LOST_HISTORY_WARNING = /WARNING: clean start on a top-level turn/;

const testAgentDir = mkdtempSync(join(tmpdir(), "subagent-delayed-dir-"));
const testProjectDir = mkdtempSync(join(tmpdir(), "subagent-delayed-project-"));
mkdirSync(join(testProjectDir, "src"), { recursive: true });
writeFileSync(join(testProjectDir, "package.json"), JSON.stringify({ name: "subagent-delayed-fixture", private: true }, null, 2));
writeFileSync(join(testProjectDir, "src", "sentinel.ts"), "export const DELAYED_DISPATCH_SENTINEL = 'delayed-dispatch';\n");

const harness = createRpcHarness({
	name: "subagent-delayed-dispatch",
	bin: "omp",
	args: ["--model", BRIDGE_MODEL],
	cwd: testProjectDir,
	env: { PI_CODING_AGENT_DIR: testAgentDir },
	defaultTimeout: TEST_TIMEOUT,
});

const { startAndWait, stop, send, waitForEvent, collectText, DEBUG_LOG, RPC_LOG } = harness;

function debugLog() {
	try { return readFileSync(DEBUG_LOG, "utf8"); } catch { return ""; }
}

// Counting `fresh query setup` lines cannot identify the child: the parent's own
// post-dispatch turn logs one too, and a child that starts inside the parent's
// turn has already logged its own before the parent's `agent_end`. Wait for the
// precondition instead — a second query completing after the dispatch — and let
// the assertions decide what happened.
async function waitForChildCompletion(baselineLength, deadlineMs) {
	const started = Date.now();
	while (Date.now() - started < deadlineMs) {
		const slice = debugLog().slice(baselineLength);
		if ([...slice.matchAll(/provider: query done, session=/g)].length >= 2) return;
		if (/prompt-capture: no capture/.test(slice)) {
			throw new Error("the subagent never made a model call: its system prompt was not captured, so this run cannot exercise the race");
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error("only one query completed after the dispatch: no subagent ran, so this run proves nothing");
}

await startAndWait();

try {
	// Taken before the dispatch: a child that starts inside the parent's turn logs
	// its query before the parent finishes, and a baseline captured after
	// `agent_end` would skip past it and match the parent's next call instead.
	const beforeDispatch = debugLog().length;
	const first = collectText();
	await send({
		type: "prompt",
		message: `Remember this codeword for later: ${CODEWORD}.

Then use the task tool exactly once, with a single item in tasks[]:
- task: ${CHILD_TASK}

Do not wait for it and do not use any other tool. As soon as the task tool returns, reply exactly PARENT-DISPATCHED-BACKGROUND and write nothing else.`,
	}, TEST_TIMEOUT);
	await waitForEvent("agent_end", TEST_TIMEOUT);
	const firstText = first.stop();
	assert.match(firstText, /PARENT-DISPATCHED-BACKGROUND/, `parent did not dispatch the subagent. Text: ${firstText.slice(0, 500)}`);

	await waitForChildCompletion(beforeDispatch, 120_000);

	const second = collectText();
	await send({
		type: "prompt",
		message: "What was the codeword I gave you? Reply with only the codeword, nothing else.",
	}, TEST_TIMEOUT);
	await waitForEvent("agent_end", TEST_TIMEOUT);
	const secondText = second.stop();

	assert.match(
		secondText,
		new RegExp(CODEWORD),
		`the parent answered out of the subagent's transcript. Text: ${secondText.slice(0, 500)}`,
	);

	// Scoped to what the dispatch produced: the parent's own turns take these
	// paths routinely. Not asserting the absence of a rebuild — a task
	// notification lands as new host messages, and rebuilding from them is
	// ordinary behaviour rather than evidence the child took anything.
	const sinceDispatch = debugLog().slice(beforeDispatch);
	assert.doesNotMatch(sinceDispatch, LOST_HISTORY_WARNING, "a subagent query was treated as a top-level turn with lost history");
	assert.match(sinceDispatch, ISOLATED, "no subagent query was isolated from the shared session, so a delayed child is still free to take it");

	console.log("PASS");
} catch (err) {
	process.exitCode = 1;
	console.log(`FAIL: ${err.message}\n${err.stack}`);
	console.log(`  RPC log:    ${RPC_LOG}`);
	console.log(`  Debug log:  ${DEBUG_LOG}`);
	try { console.log(`  Debug tail:\n${readFileSync(DEBUG_LOG, "utf8").slice(-4000)}`); } catch {}
} finally {
	await stop();
	rmSync(testAgentDir, { recursive: true, force: true });
	rmSync(testProjectDir, { recursive: true, force: true });
}
