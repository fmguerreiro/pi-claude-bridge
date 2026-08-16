/**
 * The AskClaude schema is a safety surface: execute resolves `mode` and
 * `isolated` from configured defaults, so text claiming the package defaults is
 * not a cosmetic bug — a model omits `mode` on the schema's word that the
 * default is read-only and gets a write-capable child (issue #65).
 *
 * These tests pin both halves: the default config still produces the exact
 * strings it always did, and a customized config is stated honestly in the
 * schema, the tool description and the status line.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	askClaudeCallTags,
	askClaudeToolDescription,
	buildAskClaudeParams,
	resolveAskClaudeDefaults,
} from "../src/askclaude-schema.js";

const props = (conf) => buildAskClaudeParams(resolveAskClaudeDefaults(conf)).properties;
const toolDesc = (conf) => askClaudeToolDescription(resolveAskClaudeDefaults(conf), conf?.description);
const tags = (args, conf) => askClaudeCallTags(args, resolveAskClaudeDefaults(conf));

describe("default configuration", () => {
	it("keeps the descriptions the tool shipped with", () => {
		const p = props(undefined);
		assert.equal(p.prompt.description, "The question or task for Claude Code. By default Claude sees the full conversation history. Don't research up front, let Claude explore.");
		assert.equal(p.mode.description, '"read" (default): questions about the codebase — review, analysis, explain. "none": general knowledge only (no file access). "full": allows writing and bash execution (careful: runs without feedback to pi).');
		assert.equal(p.isolated.description, "When true, Claude sees only this prompt (clean session). When false (default), Claude sees the full conversation history.");
		assert.equal(toolDesc(undefined), "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself.");
	});

	it("offers every mode and tags nothing on a bare call", () => {
		assert.deepEqual(props({}).mode.enum, ["read", "full", "none"]);
		assert.deepEqual(tags({ prompt: "hi" }, {}), []);
	});

	it("still tags what the model asked for explicitly", () => {
		assert.deepEqual(tags({ prompt: "hi", mode: "full", model: "sonnet", thinking: "high", isolated: true }, {}),
			["mode=full", "model=sonnet", "thinking=high", "isolated"]);
	});
});

describe("defaultMode: full", () => {
	const conf = { defaultMode: "full" };

	it("states full as the default in the mode parameter", () => {
		const desc = props(conf).mode.description;
		assert.match(desc, /"full" \(default\)/);
		assert.doesNotMatch(desc, /"read" \(default\)/);
	});

	it("states full as the default in the tool description", () => {
		const desc = toolDesc(conf);
		assert.match(desc, /Defaults to full mode/);
		assert.doesNotMatch(desc, /Defaults to read-only mode/);
	});

	// The whole point of #65: an inherited full mode has to be visible, so the
	// user can see that a call they read as a question could write files.
	it("renders the inherited mode in the status line", () => {
		assert.deepEqual(tags({ prompt: "review this" }, conf), ["mode=full"]);
		assert.deepEqual(tags({ prompt: "review this", mode: "read" }, conf), []);
	});
});

describe("defaultIsolated: true", () => {
	const conf = { defaultIsolated: true };

	it("states isolation as the default in both parameter descriptions", () => {
		const p = props(conf);
		assert.equal(p.isolated.description, "When true (default), Claude sees only this prompt (clean session). When false, Claude sees the full conversation history.");
		assert.match(p.prompt.description, /By default Claude sees only this prompt \(isolated session\)\./);
		assert.doesNotMatch(p.prompt.description, /By default Claude sees the full conversation history/);
	});

	it("renders isolation inherited from config, not just when passed", () => {
		assert.deepEqual(tags({ prompt: "review this" }, conf), ["isolated"]);
		assert.deepEqual(tags({ prompt: "review this", isolated: true }, conf), ["isolated"]);
		assert.deepEqual(tags({ prompt: "review this", isolated: false }, conf), []);
	});
});

describe("allowFullMode: false", () => {
	it("removes full from the selectable modes", () => {
		const p = props({ allowFullMode: false });
		assert.deepEqual(p.mode.enum, ["read", "none"]);
		assert.doesNotMatch(p.mode.description, /"full"/);
		assert.equal(toolDesc({ allowFullMode: false }), "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories). Read-only — Claude Code can explore the codebase but not make changes. Prefer to handle straightforward tasks yourself.");
	});

	// A lockout that defaultMode could route around would be no lockout: execute
	// takes the same resolved value, so clamping here disarms the config too.
	it("beats a defaultMode that asks for full", () => {
		const conf = { allowFullMode: false, defaultMode: "full" };
		assert.equal(resolveAskClaudeDefaults(conf).mode, "read");
		assert.match(props(conf).mode.description, /"read" \(default\)/);
		assert.deepEqual(tags({ prompt: "hi" }, conf), []);
	});
});

describe("defaultMode: none", () => {
	it("marks none as the default and says so at the top level", () => {
		assert.match(props({ defaultMode: "none" }).mode.description, /"none" \(default\)/);
		assert.match(toolDesc({ defaultMode: "none" }), /Defaults to no file access/);
		assert.match(toolDesc({ defaultMode: "none", allowFullMode: false }), /Defaults to no file access/);
	});

	it("renders the inherited mode in the status line", () => {
		assert.deepEqual(tags({ prompt: "what is a monad" }, { defaultMode: "none" }), ["mode=none"]);
	});
});

// The override is the escape hatch for anyone who dislikes the generated text;
// generating from defaults must not start editing it.
describe("description override", () => {
	it("wins verbatim over every generated default", () => {
		assert.equal(toolDesc({ description: "Ask the other Claude.", defaultMode: "full", defaultIsolated: true }), "Ask the other Claude.");
	});
});
