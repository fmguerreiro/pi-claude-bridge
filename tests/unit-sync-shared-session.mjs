/**
 * Regression tests for syncSharedSession's session reuse decisions.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, deleteSession, openSession } from "cc-session-io";

const { __test } = await import("../src/index.js");

describe("syncSharedSession", () => {
	afterEach(() => {
		__test.resetSharedSession();
		__test.setPiUI(null);
	});

	// The branch this exercises is the guard that stops a reentrant subagent from
	// resuming — and then overwriting — the parent's session: a subagent's context
	// is shorter than the parent's cursor, so it starts fresh and the parent's
	// session is preserved. It was previously described here as the compact-summary
	// path, which cannot reach syncSharedSession at all, so the branch read as
	// covered for a case that never happens.
	// The reentrant flag is what selects this branch: on a top-level turn the same
	// shorter context means pi rewrote its own history, and rebuilding from it is
	// the only way to keep the conversation (see unit-session-sync.mjs).
	it("starts a fresh session for a shorter context and preserves the parent's", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		try {
			const mainSession = {
				sessionId: "11111111-1111-4111-8111-111111111111",
				cursor: 42,
				cwd,
			};
			__test.setSharedSession(mainSession);

			const result = __test.syncSharedSession([
				{
					role: "user",
					content: "Summarize this conversation.",
					timestamp: Date.now(),
				},
			], cwd, undefined, undefined, { reentrant: true });

			assert.equal(
				result.sessionId,
				null,
				"a context shorter than the cursor — a subagent, or AskClaude — must start a fresh Claude Code session instead of resuming the parent's",
			);
			assert.equal(
				result.preserveSharedSession,
				true,
				"the fresh session must not replace the parent's when it completes",
			);
			assert.deepEqual(__test.getSharedSession(), mainSession);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// The rebuilt file holds one line per record, and a carried `@file` expansion
	// is an `attachment` record — which `session.messages` filters out. Counting
	// messages told every user who at-mentioned a file before switching providers
	// that their session was corrupt, and asked them to open an issue about it.
	it("does not report a count mismatch when a rebuild carries an attachment", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const sessionId = randomUUID();
		const prompt = "Review @fixture.txt and remember it.";
		const notices = [];
		try {
			const seeded = createSession({ sessionId, projectPath: cwd });
			seeded.importMessages(
				[
					{ role: "user", content: prompt },
					{ role: "assistant", content: [{ type: "text", text: "Noted." }] },
				],
				{
					attachments: [{
						afterIndex: 0,
						attachment: {
							type: "file",
							filename: join(cwd, "fixture.txt"),
							content: { type: "text", file: { filePath: join(cwd, "fixture.txt"), content: "token" } },
						},
					}],
				},
			);
			seeded.save();

			__test.setSharedSession({ sessionId, cursor: 0, cwd });
			__test.setPiUI({ notify: (message) => notices.push(message) });
			__test.syncSharedSession([
				{ role: "user", content: prompt, timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "Noted." }], timestamp: Date.now() },
				{ role: "user", content: "Now what did it say?", timestamp: Date.now() },
			], cwd);

			assert.equal(
				openSession({ sessionId, projectPath: cwd }).attachments.length,
				1,
				"the rebuild did not carry the attachment, so this proves nothing about the count",
			);
			assert.deepEqual(notices, []);
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// A side-agent query (advisor, title generator, idle recap) fires after the
	// main turn already settled, so it is not reentrant, and its prompt is a
	// pass-through that shares no substantial prefix with the main conversation's
	// recorded prompt. Left to fall through it hit REBUILD, overwrote the shared
	// session with its own id, and fired the "no conversation history" notify —
	// this is the branch that stops that.
	it("leaves the shared session untouched for a foreign conversation with no priors", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const notices = [];
		try {
			const mainSession = {
				sessionId: "22222222-2222-4222-8222-222222222222",
				cursor: 4,
				cwd,
			};
			__test.setSharedSession(mainSession);
			__test.setPiUI({ notify: (message) => notices.push(message) });

			const result = __test.syncSharedSession([
				{
					role: "user",
					content: "What should the user try next?",
					timestamp: Date.now(),
				},
			], cwd, undefined, undefined, { reentrant: false, foreignConversation: true });

			assert.equal(result.sessionId, null, "a foreign conversation with no priors of its own must not resume or rebuild anything");
			assert.equal(result.preserveSharedSession, true, "the completion handler must not treat this as the main conversation's session");
			assert.deepEqual(__test.getSharedSession(), mainSession, "a foreign conversation must never overwrite the main conversation's shared session");
			assert.deepEqual(notices, [], "the no-conversation-history warning is for a real user turn, not a side-agent query");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("imports its own priors for a foreign conversation without touching the main session", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const mainSessionId = randomUUID();
		try {
			const seeded = createSession({ sessionId: mainSessionId, projectPath: cwd });
			seeded.importMessages([
				{ role: "user", content: "Main conversation prompt." },
				{ role: "assistant", content: [{ type: "text", text: "Main conversation reply." }] },
			]);
			seeded.save();
			const mainSession = { sessionId: mainSessionId, cursor: 2, cwd };
			__test.setSharedSession(mainSession);

			const result = __test.syncSharedSession([
				{ role: "user", content: "Advisor context turn one.", timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "Advisor reply one." }], timestamp: Date.now() },
				{ role: "user", content: "Advisor context turn two.", timestamp: Date.now() },
			], cwd, undefined, undefined, { reentrant: false, foreignConversation: true });

			assert.equal(result.preserveSharedSession, true);
			assert.ok(result.sessionId, "a foreign conversation with priors must still get its own history imported");
			assert.notEqual(result.sessionId, mainSessionId, "a foreign conversation must get a session distinct from the main conversation's, never reuse it");
			assert.deepEqual(__test.getSharedSession(), mainSession, "the main conversation's shared session must be untouched");

			const foreignSession = openSession({ sessionId: result.sessionId, projectPath: cwd });
			assert.equal(foreignSession.messages.length, 2, "the foreign session must carry the side-agent's own priors");

			const mainStillIntact = openSession({ sessionId: mainSessionId, projectPath: cwd });
			assert.equal(mainStillIntact.messages.length, 2, "the main conversation's session file must not have been deleted or rewritten");
		} finally {
			deleteSession(mainSessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
