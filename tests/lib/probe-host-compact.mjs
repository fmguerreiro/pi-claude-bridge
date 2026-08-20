// Interrogates each *installed host* about the two summarization entry points the
// bridge takes over, using the exact call shape src/index.ts sends that host.
//
// Runs under Bun: OMP's source imports `.md` prompt files, which node cannot load.
// Prints one JSON object per host to stdout. A host that is not installed reports
// `available: false` so the caller can skip rather than fail.

const HOSTS = {
	omp: {
		roots: [
			process.env.OMP_AGENT_CORE,
			`${process.env.HOME}/.bun/install/global/node_modules/@oh-my-pi/pi-agent-core`,
			"/usr/local/lib/node_modules/@oh-my-pi/pi-agent-core",
		],
		entry: "/src/compaction.ts",
	},
	pi: {
		roots: [
			process.env.PI_CODING_AGENT,
			...(process.env.MISE_INSTALLS
				? [`${process.env.MISE_INSTALLS}/@earendil-works/pi-coding-agent`]
				: []),
			`${process.env.HOME}/.local/share/mise/installs/node/22.23.1/lib/node_modules/@earendil-works/pi-coding-agent`,
			"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
		],
		entry: "/dist/core/compaction/index.js",
	},
};

async function load({ roots, entry }) {
	for (const root of roots.filter(Boolean)) {
		try {
			return { mod: await import(`${root}${entry}`), root };
		} catch {}
	}
	return null;
}

const STUB_SUMMARY = "SUMMARY-VIA-BRIDGE-OVERRIDE";

const model = {
	id: "claude-opus-4-6", api: "anthropic-messages", provider: "claude-bridge",
	baseUrl: "claude-bridge", contextWindow: 200000, maxTokens: 8192,
	reasoning: false, input: ["text"], cost: {}, compat: {},
};
const msg = (role, text) => ({ role, content: [{ type: "text", text }], timestamp: 1 });

function stubMessage() {
	return {
		role: "assistant",
		content: [{ type: "text", text: STUB_SUMMARY }],
		api: model.api, provider: model.provider, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

// Minimal stand-in for the host's own AssistantMessageEventStream: hand-rolled so
// the probe does not couple to whichever pi-ai copy a given host resolves.
function stubStream(message) {
	return {
		async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; },
		result: async () => message,
	};
}

function preparationFor(DEFAULT_COMPACTION_SETTINGS) {
	return {
		firstKeptEntryId: "keep-1",
		messagesToSummarize: [msg("user", "what is the capital of France"), msg("assistant", "Paris")],
		turnPrefixMessages: [],
		recentMessages: [msg("user", "and of Spain")],
		isSplitTurn: false,
		tokensBefore: 1234,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
	};
}

const out = {};

for (const [name, spec] of Object.entries(HOSTS)) {
	const host = await load(spec);
	if (!host) {
		out[name] = { available: false, tried: spec.roots.filter(Boolean) };
		continue;
	}
	const { compact, generateBranchSummary, DEFAULT_COMPACTION_SETTINGS } = host.mod;
	const result = {
		available: true, root: host.root,
		arity: { compact: compact.length, generateBranchSummary: generateBranchSummary.length },
	};

	let calls = 0;
	const completeImpl = async () => { calls++; return stubMessage(); };
	const streamFn = () => { calls++; return stubStream(stubMessage()); };
	const signal = new AbortController().signal;
	const entries = [{ type: "message", id: "e1", parentId: null, message: msg("user", "try approach A") }];

	// The exact argument lists callHostCompact / callHostBranchSummary send.
	calls = 0;
	try {
		const compaction = name === "pi"
			? await compact(preparationFor(DEFAULT_COMPACTION_SETTINGS), model, undefined, undefined, "focus on capitals", signal, undefined, streamFn, undefined)
			: await compact(preparationFor(DEFAULT_COMPACTION_SETTINGS), model, undefined, "focus on capitals", signal, { completeImpl });
		result.compact = { ok: true, calls, usedOverride: (compaction.summary ?? "").includes(STUB_SUMMARY) };
	} catch (err) {
		result.compact = { ok: false, calls, error: `${err.constructor.name}: ${err.message}` };
	}

	calls = 0;
	try {
		const options = name === "pi"
			? { model, signal, customInstructions: "why", streamFn }
			: { model, signal, customInstructions: "why", apiKey: undefined, completeImpl };
		const branch = await generateBranchSummary(entries, options);
		result.branchSummary = { ok: true, calls, usedOverride: (branch.summary ?? "").includes(STUB_SUMMARY) };
	} catch (err) {
		result.branchSummary = { ok: false, calls, error: `${err.constructor.name}: ${err.message}` };
	}

	out[name] = result;
}

console.log(JSON.stringify(out));
