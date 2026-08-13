import { NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { deliverBroadcastChunk } from '@/lib/whatsapp/broadcast-core'

// Kicks off (or resumes) server-side delivery for a broadcast the
// dashboard wizard already persisted (broadcasts row + its
// broadcast_recipients rows, each carrying its own params — see
// useBroadcastSending). Replaces the old design where the *browser
// tab* drove the whole send loop with a client-side batch/sleep cycle:
// that meant a multi-thousand-recipient campaign needed the tab to
// stay open, on a stable connection, for as long as the campaign took
// to send — closing the tab, the laptop sleeping, or a network blip
// permanently stalled it with no way to resume.
//
// This route does none of the sending itself: it authenticates the
// caller, confirms the broadcast belongs to their account, and hands
// off to deliverBroadcastChunk in `after()` — the same durable,
// resumable core the public /api/v1/broadcasts API uses. Whatever one
// chunk doesn't finish in its time budget is picked up by the cron
// drain (src/app/api/broadcasts/cron), not by this request or this tab.
export const maxDuration = 60

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: broadcastId } = await params
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      )
    }

    // RLS already scopes this to the caller's own rows, but the
    // explicit account_id check gives a clean 404 instead of an
    // opaque empty-result on a cross-account id guess.
    const { data: broadcast, error: bErr } = await supabase
      .from('broadcasts')
      .select('id, status')
      .eq('id', broadcastId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (bErr || !broadcast) {
      return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 })
    }
    if (broadcast.status !== 'sending') {
      // Nothing to dispatch — already terminal (sent/failed), still a
      // draft, or scheduled for later. Not an error: the caller (the
      // wizard, right after creating the broadcast) always expects
      // this to be a no-op once the campaign is done.
      return NextResponse.json({ status: broadcast.status, dispatched: false })
    }

    // Service-role client — the dashboard session's RLS-scoped client
    // isn't guaranteed to still be valid once after() runs post-response,
    // and every downstream query is already explicitly account-scoped by
    // deliverBroadcastChunk via the broadcast row itself.
    after(() => deliverBroadcastChunk(supabaseAdmin(), broadcastId))

    return NextResponse.json({ status: 'sending', dispatched: true }, { status: 202 })
  } catch (error) {
    console.error('Error dispatching broadcast:', error)
    return NextResponse.json({ error: 'Failed to dispatch broadcast' }, { status: 500 })
  }
}
