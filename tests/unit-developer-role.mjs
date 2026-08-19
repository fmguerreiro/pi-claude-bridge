#!/usr/bin/env node
// The host's `developer` role, end to end.
//
// OMP's message union is `UserMessage | DeveloperMessage | AssistantMessage |
// ToolResultMessage` (@oh-my-pi/pi-ai src/types.ts), and its advisor runtime
// appends a `developer` message every turn. The bridge knew only three of those
// four roles, which cost it twice: the turn slice came out empty and the query
// was sent with the literal "[continue]" recovery prompt, and the developer
// content never reached Claude at all because conversion had no branch for it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repairToolPairing } from "cc-session-io";
import { convertPiMessages, markDeveloperText, markAgentSteerText } from "../src/convert.js";

const { __test } = await import("../src/index.js");
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const text = (t) => [{ type: "text", text: t }];
const user = (t) => ({ role: "user", content: text(t), timestamp: 1 });
// Attribution is what splits the role in two, so no helper leaves it implicit.
// `developer` is the harness steering the agent — an advisor card, a plan-mode
// reminder, a prewalk nudge — which is also what an unstamped developer message
// normalizes to (@oh-my-pi/pi-agent-core src/compaction/messages.ts). `fromUser`
// is the human's own content riding the role, chiefly an `@file` mention's text
// half, which the host stamps `attribution: "user"` explicitly.
const developer = (t) => ({ role: "developer", content: text(t), attribution: "agent", timestamp: 1 });
const developerFromUser = (t) => ({ role: "developer", content: text(t), attribution: "user", timestamp: 1 });
const assistant = (blocks) => ({ role: "assistant", content: blocks, provider: "claude-bridge", timestamp: 1 });

// The exact context the live repro produced, from the diag record:
// {"label":"empty_prompt","messageRoles":"[0]user [1]assistant [2]developer"}
const ADVISOR_TURN = [
	user("Reply with exactly: OMP_BRIDGE_OK"),
	assistant(text("OMP_BRIDGE_OK")),
	developer("The user has been waiting a while; check in."),
];

describe("turn detection with a trailing developer message", () => {
	it("sends the developer instruction instead of the [continue] recovery prompt", () => {
		const prompt = __test.extractUserPrompt(ADVISOR_TURN);

		// The bug: turnStart stopped at `user`, so the slice was empty, the prompt
		// was null, and the guard substituted "[continue]" — a billed query whose
		// "I'm standing by. What would you like help with?" reply arrived last and
		// overwrote the correct answer.
		assert.ok(prompt, "a trailing developer message must yield a prompt");
		assert.match(prompt, /check in\./);
		assert.notEqual(prompt, "[continue]");
	});

	it("frames an advisor nudge as steering, not as the user's request", () => {
		assert.equal(
			__test.extractUserPrompt(ADVISOR_TURN),
			markAgentSteerText("The user has been waiting a while; check in."),
		);
	});

	it("starts the turn at the developer message, so history keeps the rest", () => {
		// Both halves of the history/prompt split come off this one index: a
		// message counted into the turn must not also be replayed as history.
		assert.equal(__test.turnStart(ADVISOR_TURN), 2);
	});

	it("keeps a trailing user+developer run in one turn, in order", () => {
		const messages = [
			assistant(text("done")),
			user("also fix the tests"),
			developerFromUser("<file path=\"notes.md\">todo</file>"),
		];

		assert.equal(__test.turnStart(messages), 1);
		assert.equal(
			__test.extractUserPrompt(messages),
			`also fix the tests\n${markDeveloperText('<file path="notes.md">todo</file>')}`,
		);
	});

	it("survives the second live-repro shape (two advisor rounds)", () => {
		// {"messageRoles":"[0]user [1]assistant [2]developer [3]assistant [4]developer"}
		const messages = [
			...ADVISOR_TURN,
			assistant(text("Standing by.")),
			developer("Still idle — summarize what is left."),
		];

		assert.equal(__test.turnStart(messages), 4);
		assert.match(__test.extractUserPrompt(messages), /summarize what is left/);
	});

	it("keeps images in a mixed turn and tags only the developer half", () => {
		const messages = [
			assistant(text("ok")),
			{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AAA", mimeType: "image/png" }], timestamp: 1 },
			developer("Prefer the diff view."),
		];

		assert.deepEqual(__test.extractUserPromptBlocks(messages), [
			{ type: "text", text: "look" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
			{ type: "text", text: markAgentSteerText("Prefer the diff view.") },
		]);
	});
});

describe("the [continue] fallback still covers what it was written for", () => {
	// The guard fires on `!promptText && !promptBlocks`. These are the inputs
	// that must still produce exactly that.
	const trips = (messages) => !__test.extractUserPrompt(messages) && !__test.extractUserPromptBlocks(messages);

	it("trips on an orphaned trailing tool result", () => {
		assert.equal(trips([
			user("run it"),
			assistant([{ type: "toolCall", id: "t1", name: "bash", arguments: {} }]),
			{ role: "toolResult", toolCallId: "t1", toolName: "bash", content: text("ok"), isError: false, timestamp: 1 },
		]), true);
	});

	it("trips on a context ending in an assistant message", () => {
		assert.equal(__test.extractUserPrompt([user("hi"), assistant(text("hello"))]), null);
	});

	it("trips on a developer message with no text at all", () => {
		// Empty content is not an instruction; sending the bare tag would ask
		// Claude to answer nothing, which is the failure this whole file is about.
		assert.equal(trips([user("hi"), assistant(text("hello")), developer("")]), true);
	});
});

describe("developer content in the rebuilt Claude session", () => {
	it("survives conversion with its text intact and in order", () => {
		const { anthropicMessages } = convertPiMessages([
			user("start"),
			developer("Advisor: the user is in a hurry."),
			assistant(text("ack")),
		]);

		// Before: three pi messages converted to two — the developer message
		// matched no branch and was silently dropped.
		assert.equal(anthropicMessages.length, 3);
		assert.deepEqual(anthropicMessages[1], {
			role: "user",
			content: [{ type: "text", text: markAgentSteerText("Advisor: the user is in a hurry.") }],
		});
	});

	it("folds one tag around a note split across text blocks", () => {
		const { anthropicMessages } = convertPiMessages([
			{ role: "developer", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }], timestamp: 1 },
		]);

		// Unstamped on purpose: an attribution-less developer message is a steer,
		// matching the default pi-agent-core's own normalizer applies.
		assert.deepEqual(anthropicMessages[0].content, [
			{ type: "text", text: markAgentSteerText("first\nsecond") },
		]);
	});

	it("accepts string content the same way a user message does", () => {
		const { anthropicMessages } = convertPiMessages([{ role: "developer", content: "be terse", timestamp: 1 }]);
		assert.equal(anthropicMessages[0].content, markAgentSteerText("be terse"));
	});

	it("replays a user-attributed note with the unchanged developer-note shaping", () => {
		// An `@file` mention's text half is the human's own content. It must keep
		// arriving as content to act on, not be reframed as guidance about a task.
		const { anthropicMessages } = convertPiMessages([
			user("summarize this"),
			developerFromUser("<file path=\"notes.md\">todo</file>"),
		]);

		assert.deepEqual(anthropicMessages[1].content, [
			{ type: "text", text: markDeveloperText('<file path="notes.md">todo</file>') },
		]);
	});

	it("keeps both kinds distinguishable in one conversation, text intact", () => {
		const { anthropicMessages } = convertPiMessages([
			user("ship the fix"),
			developerFromUser("<file path=\"a.ts\">export const a = 1;</file>"),
			assistant(text("reading")),
			developer("STOP: write the complete plan before exploring further."),
		]);

		assert.deepEqual(anthropicMessages.map((m) => m.role), ["user", "user", "assistant", "user"]);
		// Each half keeps its own framing, and neither loses a character of text.
		assert.match(anthropicMessages[1].content[0].text, /export const a = 1;/);
		assert.match(anthropicMessages[1].content[0].text, /^<developer-note>/);
		assert.match(anthropicMessages[3].content[0].text, /STOP: write the complete plan/);
		assert.match(anthropicMessages[3].content[0].text, /^<host-steer>/);
	});

	it("frames the steer as a nudge and keeps the user-visible answer intact", () => {
		// Both halves of the framing, and both were needed to fix the live repro.
		// Naming the note as guidance stopped "Please describe the task"; saying the
		// reply is still the user's answer stopped it being replaced by a status
		// report ("Acknowledged. Standing by."), which OMP would then print as the
		// answer because it is the last turn.
		const framed = markAgentSteerText("Continue task now; do not end turn here.");

		assert.match(framed, /Not from the user, not a new task/);
		assert.match(framed, /keep going on the user's original request/);
		assert.match(framed, /Your reply is what the user receives as the answer/);
		assert.match(framed, /repeat that answer verbatim and add nothing/);
		// The steer itself still reaches the model verbatim — OMP scheduled a turn
		// expecting it to be acted on, so dropping it would strand the host.
		assert.match(framed, /Guidance: Continue task now; do not end turn here\./);
	});

	it("leaves a role sequence the session rebuild can pair", () => {
		// A developer note injected between an assistant turn and its tool results
		// — a plan-mode reminder or rewind warning — must not take the pairing slot
		// repairToolPairing hands to the first user message after the assistant.
		const repaired = repairToolPairing(convertPiMessages([
			user("run both"),
			assistant([
				{ type: "toolCall", id: "a", name: "bash", arguments: {} },
				{ type: "toolCall", id: "b", name: "bash", arguments: {} },
			]),
			{ role: "toolResult", toolCallId: "a", toolName: "bash", content: text("A"), isError: false, timestamp: 1 },
			developer("Reminder: call rewind before yielding."),
			{ role: "toolResult", toolCallId: "b", toolName: "bash", content: text("B"), isError: false, timestamp: 1 },
		]).anthropicMessages);

		assert.deepEqual(repaired.map((m) => m.role), ["user", "assistant", "user", "user"]);
		// Both real results paired, neither replaced by a synthetic stub.
		assert.deepEqual(repaired[2].content.map((b) => [b.tool_use_id, b.content]), [["a", "A"], ["b", "B"]]);
		assert.deepEqual(repaired[3].content, [
			{ type: "text", text: markAgentSteerText("Reminder: call rewind before yielding.") },
		]);
	});
});

describe("log paths", () => {
	it("honors the CLAUDE_BRIDGE_DEBUG_PATH override for every log it writes", () => {
		// tests/lib/setup.mjs sets the override before src/index.ts is imported.
		const override = process.env.CLAUDE_BRIDGE_DEBUG_PATH;
		assert.ok(override, "setup.mjs must still preload the override");
		assert.equal(__test.logPaths.debug, override);
		// diagDump writes unconditionally, so the diag log has to follow the
		// override too or a plain test run appends to the real one.
		assert.equal(__test.logPaths.diag, join(dirname(override), "claude-bridge-diag.log"));
	});

	it("defaults under the active agent dir, not a hardcoded ~/.pi/agent", () => {
		// Import-time constants, so the only honest check is a fresh process.
		const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-agent-dir-"));
		try {
			const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
			delete env.CLAUDE_BRIDGE_DEBUG_PATH;
			const out = execFileSync(
				process.execPath,
				["--import", "tsx", "-e", "import('./src/index.ts').then(m => console.log(JSON.stringify(m.__test.logPaths)))"],
				{ cwd: repoRoot, env, encoding: "utf8" },
			);
			const paths = JSON.parse(out.trim().split("\n").at(-1));

			assert.equal(paths.debug, join(agentDir, "claude-bridge.log"));
			assert.equal(paths.diag, join(agentDir, "claude-bridge-diag.log"));
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
