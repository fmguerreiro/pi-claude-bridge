// Stream resilience: failure classification, the bounded transient retry
// policy, and the idle stall watchdog.
//
// Three field-reported failures that all look identical from index.ts — a query
// that ends with no useful output — but need three different answers:
//
//   #58 an exhausted subscription arrives as an ordinary error *result* string
//       ("You've hit your limit · resets 9am (Europe/Paris)"). Pi has no typed
//       error class to raise: `AssistantMessage` carries only `stopReason` and
//       `errorMessage`, and pi-ai's `isRetryableAssistantError` classifies a
//       failed turn by regex over that text (`RETRYABLE_PROVIDER_ERROR_PATTERN`
//       minus `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`). Claude Code's raw
//       wording matches neither pattern, so `fallbackModels` never fired. The
//       fix is to rewrite the message into the vocabulary pi actually reads.
//   #43 a transient 529 ("Server is temporarily limiting requests (not your
//       usage limit): Rate limited") ended the turn with no retry at all.
//   #35 the stream goes half-open during overload: no events, no throw, and the
//       bridge shows work in progress forever.
//
// Kept out of index.ts so the policy is unit-testable without spawning Claude
// Code, and so the classification order — the only subtle part — lives in one
// readable place.

/** How a failed query should be reported and whether it may be retried.
 *  - `rate-limit`: plan/quota exhaustion. Retrying is pointless; pi must see it
 *    as rate-limit class so `fallbackModels` walks to another provider (#58).
 *  - `transient`: server-side overload, transport drop, or a stalled stream.
 *    Eligible for exactly one retry (#43, #35).
 *  - `fatal`: everything else, including auth/payment/permission. Reported
 *    verbatim and never retried. */
export type FailureClass = "rate-limit" | "transient" | "fatal";

/** The SDK's `rate_limit_event.rate_limit_info`. Only the two status fields are
 *  load-bearing here; a live event looked like
 *  `{"status":"allowed","rateLimitType":"overage","overageStatus":"allowed"}`. */
export interface RateLimitInfo {
	status?: string;
	overageStatus?: string;
	rateLimitType?: string;
	resetsAt?: number | string;
	utilization?: number;
}

/** Checked first and never retried: a bad key or an unpaid account fails
 *  identically on every attempt, so a retry only doubles the user's wait. Also
 *  deliberately outranks the plan-limit patterns below — a hard quota/billing
 *  wall is something pi-ai itself classifies as non-retryable, so dressing it up
 *  as rate-limit class would not produce a fallback anyway. */
const FATAL_PATTERN =
	/\b(401|403)\b|authentication|unauthenticated|unauthorized|invalid[ _-]?api[ _-]?key|api[ _-]?key not|oauth|please (log|sign) ?in|credential|permission denied|forbidden|not permitted|payment|billing|insufficient[ _](quota|funds|credits?)|credit balance|out of budget|quota exceeded/i;

/** Server-side transient failures: the 529/503 family, transport drops, and
 *  premature stream ends. Note the #43 text names the usage limit only to deny
 *  it ("not your usage limit"), which is why the subscription patterns are
 *  consulted separately rather than by a shared "limit" token. */
const TRANSIENT_PATTERN =
	/temporarily limiting requests|not your usage limit|overloaded|\b(429|500|502|503|504|524|529)\b|service unavailable|server error|internal error|rate limited|too many requests|ECONNRESET|ETIMEDOUT|EPIPE|ENETUNREACH|EAI_AGAIN|socket hang up|fetch failed|premature close|other side closed|stream (ended|closed) (before|without)|ended without|timed out|timeout|network error|connection (error|refused|reset|lost)/i;

/** Plan/subscription exhaustion (#58). Rate-limit class rather than transient:
 *  the only useful response is a different model, which is exactly what pi's
 *  `fallbackModels` does once it can see the class. */
const SUBSCRIPTION_LIMIT_PATTERN =
	/you('?ve|'?re| have)? ?(hit|reached) your [^.\n]*limit|usage limit reached|\blimits?\b[^.\n]{0,60}\bresets?\b/i;

/** pi-ai's non-retryable tokens, which win over every retryable token in its
 *  classifier. A detail string carrying one would silence the very fallback we
 *  are trying to trigger, so a message built for pi must not contain any of
 *  them. Copied rather than imported: the predicate is not part of the API
 *  surface the bridge is willing to hard-depend on, and the bridge must keep
 *  working on hosts whose pi-ai does not export it. */
const PI_NON_RETRYABLE_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;

/** "rate limit" is the token pi-ai keys on (`rate.?limit`); "429" is a second,
 *  independent hit in the same pattern, so a wording change on either side of
 *  that regex still classifies. */
export const RATE_LIMIT_PREFIX = "Rate limit (429) from Claude Code";

const RATE_LIMIT_FALLBACK_DETAIL = "subscription or plan limit reached";

/** The `errorMessage` to hand pi for a rate-limit-class failure: pi's own
 *  vocabulary up front, Claude Code's wording (which carries the reset time the
 *  user needs) appended when it cannot defeat pi's classifier. */
export function rateLimitMessage(detail: string): string {
	const trimmed = detail.trim();
	// Classification runs on both the error-result text and, later, on whatever
	// the query rejected with — the second pass must not restack the prefix.
	if (trimmed.startsWith(RATE_LIMIT_PREFIX)) return trimmed;
	if (!trimmed || PI_NON_RETRYABLE_PATTERN.test(trimmed)) return `${RATE_LIMIT_PREFIX}: ${RATE_LIMIT_FALLBACK_DETAIL}`;
	return `${RATE_LIMIT_PREFIX}: ${trimmed}`;
}

export interface ClassifiedFailure {
	kind: FailureClass;
	/** What to put in `AssistantMessage.errorMessage`. */
	message: string;
}

/** Classify a failed query. `rateLimitRejected` is the SDK's last word on the
 *  account's standing (see `StreamMonitor.rateLimitRejected`).
 *
 *  Order is the whole design:
 *    1. auth/payment/permission — deterministic, never retried, reported as-is.
 *    2. a rejected rate-limit event — the SDK has told us the account is
 *       blocked, so even a 529-looking failure is really the wall (#58).
 *    3. transient text that is *not* also plan-exhaustion text — one retry.
 *    4. plan-exhaustion text — rate-limit class, never retried.
 *    5. anything unrecognized — fatal, verbatim. Retrying only what we
 *       recognize is what keeps a real outage from becoming a double wait. */
export function classifyFailure(text: string, rateLimitRejected = false): ClassifiedFailure {
	const message = (text ?? "").trim();
	if (message && FATAL_PATTERN.test(message)) return { kind: "fatal", message };
	if (rateLimitRejected) return { kind: "rate-limit", message: rateLimitMessage(message) };
	if (message && TRANSIENT_PATTERN.test(message) && !SUBSCRIPTION_LIMIT_PATTERN.test(message)) {
		return { kind: "transient", message };
	}
	if (message && SUBSCRIPTION_LIMIT_PATTERN.test(message)) {
		return { kind: "rate-limit", message: rateLimitMessage(message) };
	}
	return { kind: "fatal", message };
}

/** Thrown by the retry wrapper when the watchdog aborted a half-open stream.
 *  The text carries pi-ai's `timed? out` token so a turn that exhausts the
 *  bridge's own single retry is still retryable one level up (#35). */
export class StreamStalledError extends Error {
	constructor(idleMs: number) {
		super(`Claude Code stream stalled: no SDK events for ${Math.round(idleMs / 1000)}s with no tool call in flight, request timed out`);
		this.name = "StreamStalledError";
	}
}

/** #43's policy, deliberately narrow. One retry, ~800ms later, only for a
 *  transient failure that produced nothing the user has already seen. */
export const TRANSIENT_RETRY_DELAY_MS = 800;
export const MAX_TRANSIENT_RETRIES = 1;

export interface RetryDecision {
	retry: boolean;
	/** Why — logged, and the reason the unit tests assert on. */
	reason: string;
	kind: FailureClass;
	/** `errorMessage` for the turn if this is the end of the road. */
	message: string;
}

/** Whether to re-run a failed query.
 *  `outputStarted` is the hard gate: once any text or tool call has reached pi,
 *  a second attempt would duplicate it, so the original error is returned even
 *  though the failure is transient. */
export function decideRetry(input: {
	failure: unknown;
	rateLimitRejected?: boolean;
	outputStarted: boolean;
	retriesUsed: number;
	aborted?: boolean;
}): RetryDecision {
	const text = input.failure instanceof Error ? input.failure.message : String(input.failure ?? "");
	// A stall is transient by construction: the watchdog only fires when nothing
	// at all is in flight, so there is no text to second-guess.
	const classified = input.failure instanceof StreamStalledError
		? { kind: "transient" as FailureClass, message: text }
		: classifyFailure(text, input.rateLimitRejected ?? false);
	const decision = (retry: boolean, reason: string): RetryDecision => ({ retry, reason, kind: classified.kind, message: classified.message });

	if (input.aborted) return decision(false, "aborted");
	if (classified.kind !== "transient") return decision(false, `${classified.kind} failure is never retried`);
	if (input.outputStarted) return decision(false, "output already started");
	if (input.retriesUsed >= MAX_TRANSIENT_RETRIES) return decision(false, "retry budget exhausted");
	return decision(true, "transient failure before any output");
}

// --- #35: idle stall watchdog ---

/** Five minutes. The watchdog has to clear the longest *legitimate* silence in
 *  an SDK stream, and the only unbounded one — a tool call pi is executing — is
 *  excluded structurally by `hasPendingWork`. What remains is Claude Code's own
 *  side of a single API round trip: its internal retry/backoff ladder during an
 *  overload (minutes, and each `rate_limit_event` it forwards re-arms the timer
 *  anyway), a long thinking block (which streams deltas, and whose worst case —
 *  `thinking.display: omitted` — still finishes well inside this), and the
 *  time-to-first-token of a 200K-token resumed prompt (seconds). Anything past
 *  five minutes of total silence with nothing in flight is a dead stream. */
export const DEFAULT_STALL_TIMEOUT_MS = 300_000;

/** `CLAUDE_BRIDGE_STALL_TIMEOUT_MS` overrides the default; `0` or negative
 *  disables the watchdog entirely. Junk falls back to the default rather than
 *  arming a zero-delay timer that would kill every turn. */
export function stallTimeoutMs(env: Record<string, string | undefined> = process.env): number {
	const raw = env.CLAUDE_BRIDGE_STALL_TIMEOUT_MS;
	if (raw === undefined || raw === "") return DEFAULT_STALL_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_STALL_TIMEOUT_MS;
	return parsed > 0 ? parsed : 0;
}

export interface StreamMonitorOptions {
	/** Idle budget in ms. `0` disables the watchdog. */
	idleMs: number;
	/** True while Claude Code is legitimately waiting on us — a pi tool call in
	 *  flight. The watchdog must never fire then: a 20-minute build is not a
	 *  stalled stream. */
	hasPendingWork: () => boolean;
	/** Abort the SDK query. Called at most once. */
	onStall: (error: StreamStalledError) => void;
	log?: (message: string) => void;
}

/** Per-attempt observer for one SDK stream: the idle watchdog plus the last word
 *  the SDK gave us on rate limiting. One object because index.ts hangs exactly
 *  one of these off the QueryContext, and both facts are consumed together when
 *  the attempt fails. */
export class StreamMonitor {
	/** Set once the watchdog has aborted the stream. The retry wrapper reads it
	 *  because closing the SDK query makes the generator *return* rather than
	 *  throw — a stalled attempt otherwise looks like a clean, empty turn. */
	stalled = false;
	/** The error the watchdog raised, so the caller reports the stall rather than
	 *  whatever the abort happened to surface as. */
	stallError: StreamStalledError | undefined;
	/** Last `rate_limit_event` the SDK sent, whatever its status. */
	lastRateLimit: RateLimitInfo | undefined;
	/** Whether that last event refused the request — the #58 signal. */
	rateLimitRejected = false;

	private timer: NodeJS.Timeout | undefined;
	private finished = false;

	constructor(private readonly opts: StreamMonitorOptions) {}

	/** Every SDK message re-arms the timer. A `result` disarms it: the turn
	 *  reached a normal stop, and the generator's own wind-down (draining the
	 *  prompt stream, closing stdin) must not be mistaken for a stall. */
	onSdkEvent(type?: string): void {
		if (this.finished) return;
		if (type === "result") {
			this.stop();
			return;
		}
		this.arm();
	}

	noteRateLimitEvent(info: RateLimitInfo | undefined): void {
		if (!info) return;
		this.lastRateLimit = info;
		// `overageStatus` counts on its own: an account past its included usage is
		// serving off overage, and a refused overage is the wall (#58).
		this.rateLimitRejected = info.status === "rejected" || info.overageStatus === "rejected";
	}

	/** Idempotent; safe from a `finally`. */
	stop(): void {
		this.finished = true;
		this.disarm();
	}

	/** Arm or re-arm the watchdog. Public because the first arming happens before
	 *  the stream is iterated, when there is no event to react to yet. */
	arm(): void {
		if (this.opts.idleMs <= 0) return;
		this.disarm();
		this.timer = setTimeout(() => this.fire(), this.opts.idleMs);
		// Node keeps the process alive for a pending timer; a bridge query must
		// not be the reason pi refuses to exit.
		this.timer.unref?.();
	}

	private disarm(): void {
		if (this.timer === undefined) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private fire(): void {
		this.timer = undefined;
		if (this.finished) return;
		// Re-arm rather than give up: returning here — as the issue's sketch does
		// — would leave the watchdog dead for the rest of the query, so a stream
		// that stalls *after* a tool call would never be caught.
		if (this.opts.hasPendingWork()) {
			this.opts.log?.("stall watchdog: tool call in flight, re-arming");
			this.arm();
			return;
		}
		this.finished = true;
		this.stalled = true;
		this.stallError = new StreamStalledError(this.opts.idleMs);
		this.opts.log?.(`stall watchdog: ${this.stallError.message}`);
		this.opts.onStall(this.stallError);
	}
}
