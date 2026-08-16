// The AskClaude tool's parameter schema and model-facing text, derived from the
// effective config rather than from the package defaults.
//
// This lives outside index.ts because the text is a safety surface, not
// decoration. `mode` and `isolated` fall back to configured defaults at execute
// time (`params.mode ?? defaults.mode`), so a schema that hard-codes "read" and
// "false" actively misleads: under `defaultMode: "full"` a model that omits
// `mode` — precisely because the schema told it the default was read-only —
// gets a delegated Claude Code with write and bash access. Generating both from
// one resolved object is what keeps them from drifting again (issue #65).

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Config } from "./config.js";

export type AskClaudeMode = "full" | "read" | "none";

export interface AskClaudeDefaults {
	mode: AskClaudeMode;
	isolated: boolean;
	allowFull: boolean;
}

// The values a call inherits when nothing is configured. renderCall stays quiet
// about these, so the common case carries no tags and anything else is worth
// showing — including when it was inherited rather than passed explicitly.
const PACKAGE_DEFAULT_MODE: AskClaudeMode = "read";
const PACKAGE_DEFAULT_ISOLATED = false;

export function resolveAskClaudeDefaults(conf: Config["askClaude"]): AskClaudeDefaults {
	const allowFull = conf?.allowFullMode !== false;
	const configured = conf?.defaultMode ?? PACKAGE_DEFAULT_MODE;
	// `allowFullMode: false` is a lockout, so it has to beat defaultMode too.
	// Otherwise omitting `mode` hands out the one mode the config forbids, and
	// the enum wouldn't even name it.
	const mode = !allowFull && configured === "full" ? PACKAGE_DEFAULT_MODE : configured;
	return { mode, isolated: conf?.defaultIsolated ?? PACKAGE_DEFAULT_ISOLATED, allowFull };
}

function modeDescription(defaults: AskClaudeDefaults): string {
	const mark = (m: AskClaudeMode) => (m === defaults.mode ? " (default)" : "");
	const parts = [
		`"read"${mark("read")}: questions about the codebase — review, analysis, explain.`,
		`"none"${mark("none")}: general knowledge only (no file access).`,
	];
	if (defaults.allowFull) parts.push(`"full"${mark("full")}: allows writing and bash execution (careful: runs without feedback to pi).`);
	return parts.join(" ");
}

export function buildAskClaudeParams(defaults: AskClaudeDefaults) {
	const visibility = defaults.isolated
		? "By default Claude sees only this prompt (isolated session)."
		: "By default Claude sees the full conversation history.";
	const isolatedOnTrue = defaults.isolated ? " (default)" : "";
	const isolatedOnFalse = defaults.isolated ? "" : " (default)";
	// A mode the config forbids must not be offerable, so the enum tracks the
	// lockout rather than listing every mode the runtime can name.
	const modeValues: readonly AskClaudeMode[] = defaults.allowFull ? ["read", "full", "none"] : ["read", "none"];
	return Type.Object({
		prompt: Type.String({ description: `The question or task for Claude Code. ${visibility} Don't research up front, let Claude explore.` }),
		mode: Type.Optional(StringEnum(modeValues, { description: modeDescription(defaults) })),
		model: Type.Optional(Type.String({ description: 'Claude model (e.g. "opus", "sonnet", "haiku", or full ID). Defaults to "opus".' })),
		thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, { description: "Thinking effort level. Omit to use Claude Code's default." })),
		isolated: Type.Optional(Type.Boolean({ description: `When true${isolatedOnTrue}, Claude sees only this prompt (clean session). When false${isolatedOnFalse}, Claude sees the full conversation history.` })),
	});
}

/** `override` is the user's `askClaude.description`, which wins verbatim — generating from the effective defaults is only the fallback. */
export function askClaudeToolDescription(defaults: AskClaudeDefaults, override?: string): string {
	if (override !== undefined) return override;
	const suffix = " Prefer to handle straightforward tasks yourself.";
	if (!defaults.allowFull) {
		const prefix = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories). ";
		const middle = defaults.mode === "none"
			? 'Defaults to no file access — pass mode "read" to let Claude Code explore the codebase; it can never make changes.'
			: "Read-only — Claude Code can explore the codebase but not make changes.";
		return prefix + middle + suffix;
	}
	const prefix = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. ";
	const middle = defaults.mode === "full"
		? 'Defaults to full mode — Claude Code writes files and runs bash without feedback to pi; pass mode "read" to keep it to exploration.'
		: defaults.mode === "none"
			? 'Defaults to no file access — pass mode "read" to let Claude Code explore the codebase, or "full" for a task that requires changes.'
			: "Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes.";
	return prefix + middle + suffix;
}

/**
 * Tags for the AskClaude status line, built from the values the call will
 * actually run with. Inherited and explicit are deliberately indistinguishable:
 * the user needs to see that a review ran isolated, or with write access,
 * whether or not the model spelled it out in the arguments.
 */
export function askClaudeCallTags(
	args: { mode?: AskClaudeMode; model?: string; thinking?: string; isolated?: boolean },
	defaults: AskClaudeDefaults,
): string[] {
	const tags: string[] = [];
	const mode = args.mode ?? defaults.mode;
	if (mode !== PACKAGE_DEFAULT_MODE) tags.push(`mode=${mode}`);
	if (args.model) tags.push(`model=${args.model}`);
	if (args.thinking) tags.push(`thinking=${args.thinking}`);
	if ((args.isolated ?? defaults.isolated) !== PACKAGE_DEFAULT_ISOLATED) tags.push("isolated");
	return tags;
}
