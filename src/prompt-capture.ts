import type { Skill } from "@earendil-works/pi-coding-agent";
import { formatProjectContext } from "./agents-md.js";
import { renderSkillsBlock, type SkillReadTool } from "./skills.js";

// What pi assembled for one agent, kept so the bridge can append only the
// portable parts after Claude Code's own preset.

export type PromptCaptureInput = {
	custom?: string;
	append?: string;
	contextFiles: { path: string; content: string }[];
	skills: Skill[];
};

type InheritedPrompt = {
	start: number;
	end: number;
	parent: PromptCapture;
};

export type PromptCapture = PromptCaptureInput & {
	assembledPrompt: string;
	/** Exact previously assembled prompts embedded in `custom`. */
	inherited: InheritedPrompt[];
	/**
	 * Set only on a pass-through capture (see `resolveOrDerive`): whether the
	 * unaccountable prompt shares a substantial prefix with a capture this
	 * registry already knows about. `undefined` for every capture reached by
	 * `record`, revival or embedding.
	 */
	passthroughRisk?: "quiet" | "loud";
};

/** Minimum shared leading characters between an unaccountable prompt and a known
 *  capture for the match to count as "the same prompt, rewritten" rather than
 *  coincidence. Measured against this package's actual prompts
 *  (pi-coding-agent/src/prompts): the main agent prompt and the advisor prompt
 *  share nothing but the boilerplate `<system-conventions>` preamble, a 90-character
 *  overlap, despite otherwise being unrelated templates of 14k and 5k characters.
 *  512 sits comfortably above that measured coincidental overlap and far below any
 *  prefix a real rewrite of a multi-KB prompt would still share with its original. */
export const SUBSTANTIAL_PREFIX_LENGTH = 512;

function commonPrefixLength(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	let i = 0;
	while (i < max && a[i] === b[i]) i++;
	return i;
}

/** Whether projecting `capture` on its own would produce anything beyond its own
 *  `assembledPrompt` bytes: non-empty context files, non-empty skills, a set
 *  `append`, or a `custom` narrower than what was assembled (the shape pi's own
 *  `systemPromptOptions` produces). A capture with none of that — OMP's shape,
 *  where `custom` is the whole assembled prompt and everything else is empty —
 *  projects to itself verbatim (see `projectCapture`/`projectCustom`), so matching
 *  it tells us nothing about whether a rewrite actually lost anything. */
function hasPortableStructure(capture: PromptCapture): boolean {
	return (
		capture.contextFiles.length > 0 ||
		capture.skills.length > 0 ||
		capture.append !== undefined ||
		capture.custom !== capture.assembledPrompt
	);
}

/**
 * Captures keyed by the fully assembled prompt pi sends to a provider.
 *
 * A sub-agent's systemPromptOverride embeds its parent's assembled prompt
 * verbatim. Pi currently exposes that override as an ordinary custom prompt,
 * without provenance. Linking exact prior keys recovers the inheritance graph
 * without recognizing pi prose or sub-agent markers. If pi later exposes an
 * inherited-system-prompt field, it should replace this inference.
 */
export class PromptCaptures {
	private readonly captures = new Map<string, PromptCapture>();

	/** Pi rebuilds prompts when tools change, so retain only recent lookup keys.
	 *  Inheritance edges hold direct references and survive key eviction.
	 *
	 *  Set well above any plausible working set because the costs are lopsided: a
	 *  capture is tens of KB, while evicting one that is still live fails the turn.
	 *  A parent that fans out to more distinct sub-agent prompts than this before its
	 *  own next turn would be evicted despite being in use. The bound exists only to
	 *  cap an extension that rebuilds the prompt every turn, which would otherwise
	 *  grow keys without limit. */
	constructor(private readonly limit = 256) {}

	record(systemPrompt: string, input: PromptCaptureInput): void {
		const existing = this.captures.get(systemPrompt);
		const customChanged = existing?.custom !== input.custom;
		const capture = existing ?? {
			...input,
			assembledPrompt: systemPrompt,
			contextFiles: [],
			skills: [],
			inherited: [],
		};

		capture.custom = input.custom;
		capture.append = input.append;
		capture.contextFiles = input.contextFiles.map((file) => ({ ...file }));
		capture.skills = [...input.skills];
		if (!existing || customChanged) {
			capture.inherited = this.findInheritedPrompts(systemPrompt, input.custom);
		}

		// Mutate an existing node in place so descendants retain a live reference,
		// then re-insert its key so Map order tracks recency.
		this.touch(systemPrompt, capture);
	}

	/** Exact lookup only. Callers serving a query want `resolveOrDerive`. */
	resolve(systemPrompt?: string): PromptCapture | undefined {
		if (!systemPrompt) return undefined;
		const capture = this.captures.get(systemPrompt);
		if (capture) this.touch(systemPrompt, capture);
		return capture;
	}

	/** Recency is by use, not just by record. A parent agent records its prompt once
	 *  and then only ever resolves it, so counting writes alone ages it out behind the
	 *  sub-agent prompts churning past it — observed in a real 135-message session,
	 *  where the parent's own prompt was evicted and its next turn resolved to
	 *  nothing. */
	private touch(systemPrompt: string, capture: PromptCapture): void {
		this.captures.delete(systemPrompt);
		this.captures.set(systemPrompt, capture);
		// Trims here, not only in record(): reviving an evicted node re-adds a key that
		// was not in the map, so without this a run of revivals grows it without bound.
		for (const key of this.captures.keys()) {
			if (this.captures.size <= this.limit) break;
			this.captures.delete(key);
		}
	}

	/**
	 * The capture to project for one query, for both the provider and AskClaude.
	 *
	 * An exact key is the normal case. A prompt that only *embeds* known prompts —
	 * anything that wrapped what Pi assembled after we recorded it — resolves to a
	 * transient descendant over the whole prompt, so projection swaps each embedded
	 * capture for its portable parts and carries everything around them through
	 * unchanged. That surrounding text belongs to whatever did the wrapping, and
	 * dropping it would be exactly the silent instruction loss this exists to
	 * prevent. The descendant is not retained — its key is not ours to own.
	 *
	 * Falls through to a pass-through capture when a prompt can be accounted for by
	 * neither route: OMP's own side-agents (advisor, title generator, idle recap)
	 * assemble a system prompt without ever routing it through `before_agent_start`,
	 * so this registry never gets a chance to record it. Losing nothing is what makes
	 * the fallback safe rather than a silent one: `custom` is set to the whole
	 * unaccountable prompt and `inherited` is empty, so `projectCapture` renders it
	 * back out byte-for-byte — the same shape `findInheritedPrompts` already produces
	 * for the text surrounding an embedded capture above. `contextFiles` and `skills`
	 * are empty because there is nothing to lose there either: whatever assembled this
	 * prompt already rendered its own context and skills into the text.
	 *
	 * What is lost is provenance, not content — this registry cannot tell "unrelated
	 * self-contained prompt from a side-agent" apart from "a known capture that got
	 * rewritten downstream of `before_agent_start`" by construction, since neither
	 * matches by key. `passthroughRisk` on the returned capture flags the latter for
	 * the caller to surface loudly, but only when it would actually have mattered:
	 * the prompt has to share a substantial prefix with a capture we recorded (see
	 * `SUBSTANTIAL_PREFIX_LENGTH`) *and* that capture has to carry portable structure
	 * (see `hasPortableStructure`) — context files, skills, an append, or a `custom`
	 * narrower than its assembled prompt. OMP's own captures never carry that
	 * structure (its `before_agent_start` exposes no `systemPromptOptions`, so the
	 * bridge always records the whole prompt as `custom` with nothing else set), so a
	 * prompt OMP legitimately rebuilds mid-session — on memory promotion, compaction,
	 * or a tool-registry change — matches by prefix but stays quiet: the pass-through
	 * is byte-identical to what recording it properly would have produced. Loud is
	 * reserved for prompts whose matched capture, if it had been recorded fresh,
	 * would have projected to something other than its own bytes.
	 */
	resolveOrDerive(systemPrompt?: string): PromptCapture | undefined {
		if (!systemPrompt) return undefined;
		const exact = this.captures.get(systemPrompt);
		if (exact) {
			this.touch(systemPrompt, exact);
			return exact;
		}

		// A capture outlives its lookup key: eviction drops the key while inheritance
		// edges keep the node alive. findInheritedPrompts deliberately skips a node whose
		// key *is* the prompt, so without this an evicted exact match would derive
		// nothing and fall through to the pass-through path below. Touching it puts the
		// key back.
		const revived = this.reachableCaptures().find((node) => node.assembledPrompt === systemPrompt);
		if (revived) {
			this.touch(systemPrompt, revived);
			return revived;
		}

		const embedded = this.findInheritedPrompts(systemPrompt, systemPrompt);
		if (embedded.length > 0) {
			// `custom` is the prompt itself and the edges keep their original offsets, so
			// projectCustom substitutes the embedded captures in place and preserves every
			// byte between and around them.
			return { assembledPrompt: systemPrompt, custom: systemPrompt, contextFiles: [], skills: [], inherited: embedded };
		}

		const reachable = this.reachableCaptures();
		let bestMatch: PromptCapture | undefined;
		let bestPrefixLength = 0;
		for (const capture of reachable) {
			const prefixLength = commonPrefixLength(systemPrompt, capture.assembledPrompt);
			if (prefixLength > bestPrefixLength) {
				bestPrefixLength = prefixLength;
				bestMatch = capture;
			}
		}
		const rewroteKnownCapture =
			bestMatch !== undefined && bestPrefixLength >= SUBSTANTIAL_PREFIX_LENGTH && hasPortableStructure(bestMatch);
		return {
			assembledPrompt: systemPrompt,
			custom: systemPrompt,
			contextFiles: [],
			skills: [],
			inherited: [],
			passthroughRisk: rewroteKnownCapture ? "loud" : "quiet",
		};
	}

	get size(): number {
		return this.captures.size;
	}

	private findInheritedPrompts(systemPrompt: string, custom?: string): InheritedPrompt[] {
		if (!custom) return [];

		const candidates: Array<InheritedPrompt & { length: number }> = [];
		for (const parent of this.reachableCaptures()) {
			const key = parent.assembledPrompt;
			if (key === systemPrompt || key.length === 0) continue;
			for (let start = custom.indexOf(key); start !== -1; start = custom.indexOf(key, start + key.length)) {
				candidates.push({ start, end: start + key.length, length: key.length, parent });
			}
		}

		// A grandchild contains both its parent's key and the grandparent key
		// nested inside it. Keep the longest exact non-overlapping matches.
		candidates.sort((a, b) => b.length - a.length || a.start - b.start);
		const selected: InheritedPrompt[] = [];
		for (const candidate of candidates) {
			if (selected.some((edge) => candidate.start < edge.end && candidate.end > edge.start)) continue;
			selected.push({ start: candidate.start, end: candidate.end, parent: candidate.parent });
		}
		return selected.sort((a, b) => a.start - b.start);
	}

	private reachableCaptures(): PromptCapture[] {
		const result: PromptCapture[] = [];
		const seen = new Set<PromptCapture>();
		const visit = (capture: PromptCapture): void => {
			if (seen.has(capture)) return;
			seen.add(capture);
			result.push(capture);
			for (const edge of capture.inherited) visit(edge.parent);
		};
		for (const capture of this.captures.values()) visit(capture);
		return result;
	}
}

// Shared across module instances for the same reason the active streamSimple is
// (see ACTIVE_STREAM_SIMPLE_KEY in src/index.ts): an isolated sub-agent runs in a
// fresh child session that re-evaluates this module, so it gets its own registry —
// but the provider stream stays pinned to the *first* instance. The child records
// its agent's prompt from `before_agent_start`, the parent stream looks it up, and
// with per-instance registries those are two different maps. The lookup misses, and
// an isolated replace-mode prompt embeds no ancestor prompt for findInheritedPrompts
// to fall back on, so the turn throws. One registry per process makes record and
// lookup agree regardless of which instance did which.
const SHARED_CAPTURES_KEY = Symbol.for("claude-bridge:promptCaptures");

/** The one registry every module instance in this process records into and reads from.
 *
 *  Deliberately not cleared on session_shutdown, unlike the pinned stream: sibling
 *  sessions in the same process share this registry, and dropping it under a live one
 *  would fail its next turn. Growth is bounded instead — the LRU cap inside
 *  PromptCaptures (256 keys) now bounds the whole process rather than each instance,
 *  so a long-lived process running many sessions retains strictly less than before. */
export function sharedPromptCaptures(): PromptCaptures {
	const globals = globalThis as Record<symbol, PromptCaptures | undefined>;
	return (globals[SHARED_CAPTURES_KEY] ??= new PromptCaptures());
}

export function projectPromptCapture(
	capture: PromptCapture,
	options: { skillReadTool: SkillReadTool },
): string | undefined {
	return projectCapture(capture, options, new Set());
}

/** Skills visible through inherited prompts, ancestor first and once per file. */
export function collectPromptSkills(capture: PromptCapture): Skill[] {
	const result: Skill[] = [];
	const seenPaths = new Set<string>();
	const visited = new Set<PromptCapture>();
	const visiting = new Set<PromptCapture>();

	const visit = (node: PromptCapture): void => {
		if (visited.has(node)) return;
		if (visiting.has(node)) throw new Error("Cyclic prompt inheritance");
		visiting.add(node);
		for (const edge of node.inherited) visit(edge.parent);
		for (const skill of node.skills) {
			if (skill.disableModelInvocation || seenPaths.has(skill.filePath)) continue;
			seenPaths.add(skill.filePath);
			result.push(skill);
		}
		visiting.delete(node);
		visited.add(node);
	};

	visit(capture);
	return result;
}

function projectCapture(
	capture: PromptCapture,
	options: { skillReadTool: SkillReadTool },
	visiting: Set<PromptCapture>,
): string | undefined {
	if (visiting.has(capture)) throw new Error("Cyclic prompt inheritance");
	visiting.add(capture);
	try {
		const inheritedSkillPaths = new Set(
			capture.inherited.flatMap((edge) => collectPromptSkills(edge.parent).map((skill) => skill.filePath)),
		);
		const ownSkillPaths = new Set<string>();
		const ownSkills = capture.skills.filter((skill) => {
			if (skill.disableModelInvocation || inheritedSkillPaths.has(skill.filePath) || ownSkillPaths.has(skill.filePath)) {
				return false;
			}
			ownSkillPaths.add(skill.filePath);
			return true;
		});

		const custom = projectCustom(capture, options, visiting);
		const parts = [
			formatProjectContext(capture.contextFiles),
			renderSkillsBlock(ownSkills, options.skillReadTool),
			custom,
			capture.append,
		].filter((part): part is string => Boolean(part));
		return parts.length > 0 ? parts.join("\n\n") : undefined;
	} finally {
		visiting.delete(capture);
	}
}

function projectCustom(
	capture: PromptCapture,
	options: { skillReadTool: SkillReadTool },
	visiting: Set<PromptCapture>,
): string | undefined {
	if (!capture.custom || capture.inherited.length === 0) return capture.custom;

	let result = "";
	let cursor = 0;
	for (const edge of capture.inherited) {
		result += capture.custom.slice(cursor, edge.start);
		result += projectCapture(edge.parent, options, visiting) ?? "";
		cursor = edge.end;
	}
	return result + capture.custom.slice(cursor);
}
