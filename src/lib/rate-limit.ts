/**
 * Per-key rate limiter.
 *
 * Fixed-window counter. Two backends, same call signature:
 *
 *   - Upstash Redis (REST API) when UPSTASH_REDIS_REST_URL /
 *     UPSTASH_REDIS_REST_TOKEN are set. Atomic INCR+PEXPIRE via a Lua
 *     script run through Upstash's /pipeline endpoint, so the counter
 *     is shared across every instance — required once you run more
 *     than one (Cloud Run --max-instances, Vercel serverless fan-out,
 *     etc.), otherwise each instance enforces the limit independently
 *     and the effective limit is (configured limit) × (instance count).
 *
 *   - In-memory Map — the original single-instance implementation.
 *     Used automatically when the Upstash env vars are absent, so a
 *     single-VPS forker gets a working limiter with zero setup.
 *
 * Redis failures fail OPEN (request is allowed, warning logged) rather
 * than closed — a Redis outage must not take the whole app down with
 * it. This mirrors how the in-memory backend already "fails open" by
 * construction (it can't fail).
 *
 * Memory (in-memory backend only): entries are ~50 bytes each.
 * LIGHT_SWEEP below clears expired keys opportunistically on every
 * ~1000th call, so a healthy instance stays in the low-MB range even
 * with thousands of distinct users. No background timer — works in
 * serverless edge runtimes that don't keep timers alive across
 * requests.
 */

import { NextResponse } from 'next/server';

export interface RateLimitOptions {
  /** Max requests allowed in `windowMs`. */
  limit: number;
  /** Window size, milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  success: boolean;
  /** Requests still allowed in the current window. */
  remaining: number;
  /** Unix ms when the bucket refills. */
  reset: number;
  limit: number;
}

// ============================================================
// In-memory backend (fallback / single-instance deploys)
// ============================================================

interface Entry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Entry>();

// Opportunistic cleanup. Running a sweep on every call would be
// quadratic; running it 1-in-N lets the Map self-drain without a
// background timer.
const LIGHT_SWEEP_EVERY = 1000;
let callsSinceSweep = 0;

function sweepExpired(now: number) {
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}

function checkRateLimitInMemory(
  key: string,
  { limit, windowMs }: RateLimitOptions,
): RateLimitResult {
  const now = Date.now();

  callsSinceSweep += 1;
  if (callsSinceSweep >= LIGHT_SWEEP_EVERY) {
    callsSinceSweep = 0;
    sweepExpired(now);
  }

  const entry = buckets.get(key);

  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { success: true, remaining: limit - 1, reset: now + windowMs, limit };
  }

  if (entry.count >= limit) {
    return { success: false, remaining: 0, reset: entry.resetAt, limit };
  }

  entry.count += 1;
  return {
    success: true,
    remaining: limit - entry.count,
    reset: entry.resetAt,
    limit,
  };
}

// ============================================================
// Upstash Redis backend (distributed, multi-instance)
// ============================================================

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const redisEnabled = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

// Atomic increment-and-maybe-expire. Returns [count, pttlMs] from a
// single round trip so a burst of concurrent requests for the same
// key can't race between INCR and PEXPIRE (the bug a naive two-call
// implementation would have).
const INCR_WITH_TTL_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local pttl = redis.call("PTTL", KEYS[1])
return {current, pttl}
`;

async function checkRateLimitRedis(
  key: string,
  { limit, windowMs }: RateLimitOptions,
): Promise<RateLimitResult> {
  const now = Date.now();
  // Namespace so keys never collide with anything else callers might
  // put in the same Redis (e.g. a shared Upstash instance).
  const redisKey = `ratelimit:${key}`;

  const res = await fetch(`${UPSTASH_URL}/eval`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([INCR_WITH_TTL_SCRIPT, [redisKey], [String(windowMs)]]),
    // Rate-limit checks sit on the hot path of every gated request —
    // don't let a slow Redis hang the request indefinitely.
    signal: AbortSignal.timeout(2000),
  });

  if (!res.ok) {
    throw new Error(`Upstash eval failed: ${res.status} ${await res.text()}`);
  }

  const { result } = (await res.json()) as { result: [number, number] };
  const [count, pttl] = result;
  const reset = now + Math.max(pttl, 0);

  if (count > limit) {
    return { success: false, remaining: 0, reset, limit };
  }
  return { success: true, remaining: limit - count, reset, limit };
}

/**
 * Check + consume one request against `key`'s budget.
 *
 * Uses Upstash Redis when configured (required for correctness across
 * multiple instances); falls back to a local in-memory counter
 * otherwise. On a Redis error, fails open — logs a warning and allows
 * the request rather than turning a Redis outage into a full outage.
 */
export async function checkRateLimit(
  key: string,
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  if (!redisEnabled) {
    return checkRateLimitInMemory(key, options);
  }
  try {
    return await checkRateLimitRedis(key, options);
  } catch (error) {
    console.warn(
      '[rate-limit] Redis backend failed, failing open for this request:',
      error instanceof Error ? error.message : error,
    );
    return {
      success: true,
      remaining: options.limit,
      reset: Date.now() + options.windowMs,
      limit: options.limit,
    };
  }
}

/**
 * Standard 429 response with the headers clients expect (RFC 6585 +
 * draft-ietf-httpapi-ratelimit-headers). Callers just `return` this.
 */
export function rateLimitResponse(result: RateLimitResult): NextResponse {
  const retryAfterSec = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  return NextResponse.json(
    {
      error: 'Rate limit exceeded',
      retry_after_seconds: retryAfterSec,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(Math.ceil(result.reset / 1000)),
      },
    },
  );
}

/** Preconfigured budgets, tweak here not at call sites. */
export const RATE_LIMITS = {
  /** Individual message send. 60/min per user = one per second
   *  sustained, comfortable for a live human typing. */
  send: { limit: 60, windowMs: 60_000 },
  /** Broadcast dispatch. 5/min per user — even a 1 000-recipient
   *  broadcast is one call; this caps the rate at which a single user
   *  can launch campaigns, not the messages inside one. */
  broadcast: { limit: 5, windowMs: 60_000 },
  /** Reaction add/swap/remove. More permissive than send — users
   *  fidget with reactions and a single "swap" is actually two calls
   *  (remove + add) under the hood. */
  react: { limit: 120, windowMs: 60_000 },
  /** Invitation peek (public, per-IP). 30/min lets a forwarded link
   *  retry a handful of times under flaky connectivity without
   *  enabling brute-force token enumeration. With 256-bit tokens the
   *  enumeration risk is theoretical; this is belt-and-braces. */
  invitationPeek: { limit: 30, windowMs: 60_000 },
  /** Invitation redeem (authed, per-IP+user). Tighter than peek —
   *  successful redemption mutates two profiles and an invite row, so
   *  the abuse surface is "spam join attempts." */
  invitationRedeem: { limit: 10, windowMs: 60_000 },
  /** Admin-only account / member-management actions: create/revoke
   *  invitation, rename account, change member role, remove member,
   *  transfer ownership. 30/min per user is comfortably above any
   *  realistic legitimate use (the Members tab is a clicks-only UI)
   *  while still bounding accidental abuse from a script run in a
   *  loop or a compromised admin session spamming role flips. */
  adminAction: { limit: 30, windowMs: 60_000 },
  /** Public REST API (`/api/v1/*`), keyed per API key. 120/min ≈ 2
   *  req/s sustained — comfortable for a polling integration or an
   *  automation firing on inbound events, while bounding a runaway
   *  script. With the Redis backend configured this is enforced
   *  correctly across every instance; without it, it's only enforced
   *  per-instance (see the module doc comment above). */
  publicApi: { limit: 120, windowMs: 60_000 },
  /** AI draft-reply generation, per user. 20/min is generous for an
   *  agent clicking "Draft with AI" while working a thread, and bounds
   *  spend on the account's own LLM key against an accidental
   *  hold-down / script. */
  aiDraft: { limit: 20, windowMs: 60_000 },
  /** AI draft-reply generation, per account. Caps the WHOLE team's
   *  draws on the one shared BYO provider key — without this, N agents
   *  each under their per-user limit could still stampede the account's
   *  key past the provider's own rate limit. 60/min ≈ three busy agents
   *  drafting flat-out. */
  aiDraftAccount: { limit: 60, windowMs: 60_000 },
  /** AI auto-reply generation, per account. The per-conversation cap
   *  (`auto_reply_max_per_conversation`) bounds one thread; this bounds
   *  the whole account across threads, so a burst of inbound from many
   *  customers at once can't run the BYO key past the provider's limit
   *  or the owner's budget. 30/min is generous for organic inbound while
   *  capping a stampede; excess inbounds simply don't get an auto-reply
   *  (they still land in the inbox for a human). */
  aiAutoReplyAccount: { limit: 30, windowMs: 60_000 },
} as const;

/** Test-only helper. Clears the in-memory state so unit tests don't
 *  leak buckets across files. Not wired up in production code. */
export function __resetRateLimitForTests() {
  buckets.clear();
  callsSinceSweep = 0;
}
