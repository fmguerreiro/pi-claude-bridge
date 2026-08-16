#!/usr/bin/env node

/**
 * The provider registration invariant, which a subagent depends on twice over.
 *
 * A subagent runs in a fresh child session that loads this module again, so a
 * second instance reaches the registration in activate(). Two things must hold:
 *
 *  1. It MUST register. OMP's createAgentSession clears every provider entry
 *     owned by an active extension source and then re-applies only the
 *     registrations that session queued (pi-coding-agent sdk.ts →
 *     ModelRegistry.clearSourceRegistrations → unregisterCustomApis +
 *     authStorage.removeConfigApiKey). An instance that skips registration
 *     leaves the session with no `claude-bridge` api and no apiKey, and the next
 *     stream dies with "No API key for provider: claude-bridge".
 *  2. It MUST NOT register its own streamSimple. Pi merges a re-registration
 *     over the previous one, so a child's function would replace the parent's in
 *     the shared registry and the parent's next tool-result delivery would land
 *     in a closure with empty state.
 *
 * The two are only compatible because the first instance pins its streamSimple in
 * a Symbol.for() global and every later instance registers *that* function.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

const { default: activate, __test } = await import("../src/index.js");
const { pinStreamSimple, ACTIVE_STREAM_SIMPLE_KEY } = __test;

/** activate() with a mock pi, returning what it registered. */
function activateWithMockPi() {
	const registrations = [];
	const handlers = new Map();
	activate({
		on: (event, handler) => handlers.set(event, handler),
		registerProvider: (name, config) => registrations.push({ name, config }),
	});
	return { registrations, handlers };
}

afterEach(() => {
	delete globalThis[ACTIVE_STREAM_SIMPLE_KEY];
});

describe("streamSimple pinning", () => {
	it("pins the first instance's function", () => {
		const own = () => {};
		assert.equal(pinStreamSimple(globalThis, own), own);
		assert.equal(globalThis[ACTIVE_STREAM_SIMPLE_KEY], own, "the first instance to register owns the pin");
	});

	it("hands a later instance the pinned function, not its own", () => {
		const parent = () => {};
		const child = () => {};
		pinStreamSimple(globalThis, parent);
		assert.equal(pinStreamSimple(globalThis, child), parent, "a child instance must never displace the parent stream");
		assert.equal(globalThis[ACTIVE_STREAM_SIMPLE_KEY], parent);
	});
});

describe("provider registration", () => {
	it("registers claude-bridge with an apiKey and a custom api", () => {
		const { registrations } = activateWithMockPi();

		assert.equal(registrations.length, 1);
		const { name, config } = registrations[0];
		assert.equal(name, "claude-bridge");
		assert.equal(config.api, "claude-bridge", "the api id is what the host resolves streamSimple through");
		assert.ok(config.apiKey, "without an apiKey the host throws MissingApiKeyError for this provider");
		assert.equal(typeof config.streamSimple, "function");
		assert.ok(config.models.length > 0);
	});

	it("still registers when another instance already holds the pin", () => {
		const parentStream = () => {};
		globalThis[ACTIVE_STREAM_SIMPLE_KEY] = parentStream;

		const { registrations } = activateWithMockPi();

		assert.equal(
			registrations.length,
			1,
			"skipping registration here is what left OMP subagent sessions with no claude-bridge provider",
		);
		assert.equal(
			registrations[0].config.streamSimple,
			parentStream,
			"the child must re-register the parent's pinned stream, not its own",
		);
		assert.ok(registrations[0].config.apiKey, "the re-registration is what restores the provider's apiKey");
	});

	it("keeps the pin when a non-owning instance's session shuts down", () => {
		const parentStream = () => {};
		globalThis[ACTIVE_STREAM_SIMPLE_KEY] = parentStream;

		const { handlers } = activateWithMockPi();
		handlers.get("session_shutdown")({}, {});

		assert.equal(
			globalThis[ACTIVE_STREAM_SIMPLE_KEY],
			parentStream,
			"a subagent session ending must not unpin the live parent's stream",
		);
	});

	it("releases the pin when the owning instance's session shuts down", () => {
		const { registrations, handlers } = activateWithMockPi();
		const ownStream = registrations[0].config.streamSimple;
		assert.equal(globalThis[ACTIVE_STREAM_SIMPLE_KEY], ownStream);

		handlers.get("session_shutdown")({}, {});

		assert.equal(globalThis[ACTIVE_STREAM_SIMPLE_KEY], undefined, "/reload must be able to pin a fresh instance");
	});
});
