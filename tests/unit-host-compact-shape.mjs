#!/usr/bin/env node

/**
 * The two summarization takeovers call host functions whose signatures differ
 * between Pi and OMP, behind a `codingAgent as unknown as HostCodingAgent` cast.
 * Sending one host the other's shape is silent, not a type error: the wrong slots
 * take the wrong values, the summarization override is dropped, and the host
 * falls back to resolving the bridge model through its own provider — which is
 * how `/compact` came to fail with "No API key for provider: claude-bridge" on
 * OMP, and later "No API provider registered for api: claude-bridge" on Pi.
 *
 * The declarations in src/index.ts are hand-written, so the compiler checks each
 * call against our own description of a host rather than against the host. These
 * tests close that gap from both ends:
 *
 *   1. every installed host really has the arity the dispatcher keys on, and
 *      really routes summarization through the override the bridge hands it;
 *   2. `detectHostSummarizationApi` maps each host's real arity to the shape
 *      written for that host.
 *
 * The probe runs under Bun because OMP's source imports `.md` prompt files.
 * A host that is not installed is skipped, not failed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { __test } = await import("../src/index.js");
const { detectHostSummarizationApi } = __test;

const probe = join(dirname(fileURLToPath(import.meta.url)), "lib", "probe-host-compact.mjs");

function runProbe() {
	try {
		return JSON.parse(execFileSync("bun", [probe], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
	} catch (err) {
		if (err.code === "ENOENT") return null;
		throw err;
	}
}

/** A function whose only interesting property is its arity, which is what the
 *  dispatcher reads. */
const stubWithArity = (n) => new Function(...Array.from({ length: n }, (_, i) => `a${i}`), "");

const hosts = runProbe();

// arity => the call shape src/index.ts writes for that host
const EXPECTED = {
	omp: { compact: 6, api: "omp-options", dir: "/home/u/.omp/agent" },
	pi: { compact: 11, api: "pi-positional", dir: "/home/u/.pi/agent" },
};

for (const [name, expected] of Object.entries(EXPECTED)) {
	describe(`installed ${name} host summarization contract`, () => {
		const host = hosts?.[name];

		it("exposes the argument count the dispatcher keys on", (t) => {
			if (!hosts) return t.skip("bun not on PATH");
			if (!host.available) return t.skip(`not installed (tried ${host.tried.join(", ")})`);
			assert.equal(host.arity.compact, expected.compact,
				`compact changed shape; the hand-declared ${name} signature in src/index.ts is stale`);
			assert.equal(host.arity.generateBranchSummary, 2,
				"generateBranchSummary is no longer (entries, options)");
		});

		it("is dispatched the shape written for it", (t) => {
			if (!hosts) return t.skip("bun not on PATH");
			if (!host.available) return t.skip("not installed");
			assert.equal(
				detectHostSummarizationApi(stubWithArity(host.arity.compact), expected.dir),
				expected.api,
				`a ${host.arity.compact}-argument compact must be dispatched as ${expected.api}`,
			);
		});

		it("routes compaction through the override the bridge passes", (t) => {
			if (!hosts) return t.skip("bun not on PATH");
			if (!host.available) return t.skip("not installed");
			assert.equal(host.compact.ok, true, `compact rejected the call: ${host.compact.error}`);
			assert.ok(host.compact.calls > 0, "the host never called the override, so the takeover is not in effect");
			assert.ok(host.compact.usedOverride, "the summary did not come from the override");
		});

		it("routes branch summarization through the override the bridge passes", (t) => {
			if (!hosts) return t.skip("bun not on PATH");
			if (!host.available) return t.skip("not installed");
			assert.equal(host.branchSummary.ok, true, `generateBranchSummary rejected the options: ${host.branchSummary.error}`);
			assert.ok(host.branchSummary.calls > 0, "the host never called the override");
			assert.ok(host.branchSummary.usedOverride, "the summary did not come from the override");
		});
	});
}
