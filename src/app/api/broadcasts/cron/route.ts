import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { deliverBroadcastChunk } from '@/lib/whatsapp/broadcast-core'

// Drains in-flight broadcasts (`broadcasts.status = 'sending'`) that
// still have pending recipients. Meant to be hit on a schedule
// (external pinger / GCP Cloud Scheduler / Vercel Cron) — requires a
// shared secret via the `x-cron-secret` header to match
// `BROADCAST_CRON_SECRET`. Mirrors src/app/api/automations/cron/route.ts.
//
// Why this exists: both broadcast send paths (the dashboard wizard and
// the public /api/v1/broadcasts API) fan out via deliverBroadcastChunk
// inside a single request/after() call, time-boxed well under any
// platform's request timeout. A broadcast large enough to need more
// than one chunk — or one whose first chunk was cut short by a crashed
// instance, a deploy, or a killed request — is left with status still
// 'sending' and some recipients still 'pending'. Without this endpoint
// running on a schedule, that broadcast never finishes: nothing else
// in the system ever revisits it.
//
// Set this up once per deployment (not per account) — one pinger
// drains every account's in-flight broadcasts.
export const maxDuration = 55

// Per-broadcast budget, not the whole request's. Keeps the total work
// this invocation can do bounded to roughly
// BROADCAST_LIMIT * PER_BROADCAST_BUDGET_MS, safely under maxDuration
// even in the worst case where every candidate broadcast is starved for
// its full budget.
const PER_BROADCAST_BUDGET_MS = 10_000
const BROADCAST_LIMIT = 5

export async function GET(request: Request) {
  const expected = process.env.BROADCAST_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()

  const { data: inFlight, error } = await admin
    .from('broadcasts')
    .select('id')
    .eq('status', 'sending')
    .order('created_at', { ascending: true })
    .limit(BROADCAST_LIMIT)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!inFlight || inFlight.length === 0) return NextResponse.json({ drained: 0 })

  const results = []
  for (const row of inFlight) {
    const result = await deliverBroadcastChunk(admin, row.id as string, {
      budgetMs: PER_BROADCAST_BUDGET_MS,
    })
    results.push(result)
  }

  return NextResponse.json({ drained: results.length, results })
}
