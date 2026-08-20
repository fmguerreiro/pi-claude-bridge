// Interrogates the *installed OMP host* about the two summarization entry points
// the bridge takes over. Runs under Bun because the host's source imports `.md`
// prompt files, which node cannot load.
//
// Prints one JSON object to stdout. `{ available: false }` when the host is not
// installed, so the caller can skip rather than fail.

const CANDIDATES = [
	process.env.OMP_AGENT_CORE,
	`${process.env.HOME}/.bun/install/global/node_modules/@oh-my-pi/pi-agent-core`,
	"/usr/local/lib/node_modules/@oh-my-pi/pi-agent-core",
	"/opt/homebrew/lib/node_modules/@oh-my-pi/pi-agent-core",
].filter(Boolean);

async function loadHost() {
	for (const root of CANDIDATES) {
		try {
			return { mod: await import(`${root}/src/compaction.ts`), root };
		} catch {}
	}
	return null;
}

const host = await loadHost();
if (!host) {
	console.log(JSON.stringify({ available: false, tried: CANDIDATES }));
	process.exit(0);
}

const { compact, generateBranchSummary, DEFAULT_COMPACTION_SETTINGS } = host.mod;

const STUB_SUMMARY = "SUMMARY-VIA-COMPLETE-IMPL";
let completeImplCalls = 0;
const completeImpl = async (model) => {
	completeImplCalls++;
	return {
		role: "assistant",
		content: [{ type: "text", text: STUB_SUMMARY }],
		api: model.api, provider: model.provider, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
};

const model = {
	id: "claude-opus-4-6", api: "anthropic-messages", provider: "claude-bridge",
	baseUrl: "claude-bridge", contextWindow: 200000, maxTokens: 8192,
	reasoning: false, input: ["text"], cost: {}, compat: {},
};
const msg = (role, text) => ({ role, content: [{ type: "text", text }], timestamp: 1 });

// remoteEnabled: false keeps the run local — no provider request is attempted.
const preparation = {
	firstKeptEntryId: "keep-1",
	messagesToSummarize: [msg("user", "what is the capital of France"), msg("assistant", "Paris")],
	turnPrefixMessages: [],
	recentMessages: [msg("user", "and of Spain")],
	isSplitTurn: false,
	tokensBefore: 1234,
	fileOps: { read: new Set(), written: new Set(), edited: new Set() },
	settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
};

const result = { available: true, root: host.root, arity: {}, compact: {}, branchSummary: {} };
result.arity.compact = compact.length;
result.arity.generateBranchSummary = generateBranchSummary.length;

// The exact argument shape src/index.ts passes.
try {
	const compaction = await compact(
		preparation, model, undefined, "focus on capitals", undefined, { completeImpl },
	);
	result.compact = { ok: true, calls: completeImplCalls, usedStub: compaction.summary.includes(STUB_SUMMARY) };
} catch (err) {
	result.compact = { ok: false, error: `${err.constructor.name}: ${err.message}` };
}

completeImplCalls = 0;
const entries = [{
	type: "message", id: "e1", parentId: null,
	message: msg("user", "try approach A"),
}];
try {
	const branch = await generateBranchSummary(entries, {
		model, signal: new AbortController().signal, customInstructions: "why",
		apiKey: undefined, completeImpl,
	});
	result.branchSummary = { ok: true, calls: completeImplCalls, usedStub: (branch.summary ?? "").includes(STUB_SUMMARY) };
} catch (err) {
	result.branchSummary = { ok: false, error: `${err.constructor.name}: ${err.message}` };
}

console.log(JSON.stringify(result));
