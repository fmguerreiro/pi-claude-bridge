#!/usr/bin/env node

/**
 * `HostCodingAgent.compact` / `.generateBranchSummary` in src/index.ts are
 * hand-declared: the `@earendil-works` package this builds against still carries
 * the older shape, so the compiler checks the call against our own declaration
 * rather than against the host that will serve it. Nothing then notices when the
 * host moves — which is how the takeover came to pass an 11-argument positional
 * call to a 6-argument function, dropping the completion override and failing
 * every compaction with "No API key for provider: claude-bridge".
 *
 * So this asks the installed host directly: the arity it really exposes, and
 * whether it really routes summarization through `options.completeImpl`. The
 * probe runs under Bun because the host's source imports `.md` prompt files.
 *
 * Companion to unit-pi-streamfn-inventory.mjs, which audits the `@earendil-works`
 * package. This one audits the host that actually runs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const probe = join(dirname(fileURLToPath(import.meta.url)), "lib", "probe-host-compact.mjs");

function runProbe() {
	try {
		return JSON.parse(execFileSync("bun", [probe], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
	} catch (err) {
		if (err.code === "ENOENT") return { available: false, reason: "bun not on PATH" };
		throw err;
	}
}

const host = runProbe();

describe("installed host summarization contract", () => {
	it("exposes the argument counts src/index.ts is written against", (t) => {
		if (!host.available) return t.skip(`host not installed (${host.reason ?? host.tried?.join(", ")})`);
		assert.equal(host.arity.compact, 6, "compact grew or lost parameters; the hand-declared HostCodingAgent signature is stale");
		assert.equal(host.arity.generateBranchSummary, 2, "generateBranchSummary is no longer (entries, options)");
	});

	it("routes compaction through options.completeImpl", (t) => {
		if (!host.available) return t.skip("host not installed");
		assert.equal(host.compact.ok, true, `compact rejected the call shape: ${host.compact.error}`);
		assert.ok(host.compact.calls > 0, "the host never called completeImpl, so the takeover is not in effect");
		assert.ok(host.compact.usedStub, "the summary did not come from completeImpl");
	});

	it("routes branch summarization through options.completeImpl", (t) => {
		if (!host.available) return t.skip("host not installed");
		assert.equal(host.branchSummary.ok, true, `generateBranchSummary rejected the options: ${host.branchSummary.error}`);
		assert.ok(host.branchSummary.calls > 0, "the host never called completeImpl");
		assert.ok(host.branchSummary.usedStub, "the summary did not come from completeImpl");
	});
});
