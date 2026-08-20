# Meta internal deployment checklist

Client creates/owns Meta Business Portfolio.
Client creates or owns Meta Business App.
Add WhatsApp product.
Create/select client's WABA.
Register client's actual business phone number.
Verify the phone number.
Create System User.
Give required WABA/App permissions.
Generate production access token.
Collect phone_number_id and waba_id.
Configure client CRM with encrypted access token.
Put client's META_APP_SECRET in GCP Secret Manager.
Put client's META_APP_ID in deployment configuration if required.
Generate a unique webhook verify token.
Configure callback URL such as https://crm.client.com/api/whatsapp/webhook.
Subscribe Meta webhook events.
Send/receive test messages.
Test templates.
Test broadcasts.
Remove your unnecessary Meta/admin access after handover.

The wacrm webhook setup requires the callback URL, matching verify token, and META_APP_SECRET for signature verification.




# WhatsApp Cloud API — production setup per client

This is the checklist for taking a new client from "signed contract" to
"live, production-grade WhatsApp number connected to their CRM instance."
Follow it in order — several steps block later ones (App Review blocks
higher messaging tiers; a verified Business Manager blocks App Review).

Two roles appear throughout: **you** (the CRM operator/implementer) and
**the client** (owns the Meta Business Manager and the phone number).
Some steps only the client's Business Manager admin can do — Meta ties
ownership to their Business Manager, not to you, so the client stays in
control of their own number and can leave without you holding the keys.

## 1. Client-side Meta prerequisites

The client needs, in this order:

1. **A Meta Business Manager** ([business.facebook.com](https://business.facebook.com)) —
   if they don't have one, create it under their legal business name, not
   yours. This is the account App Review, WABA ownership, and billing all
   attach to.
2. **Business verification** (Business Manager → Business Settings →
   Security Center → Start Verification). Requires a legal business
   document (registration certificate, tax ID, utility bill matching the
   business address). This is the single slowest step — can take days to
   weeks — so kick it off first, in parallel with everything else below.
   Unverified businesses are capped hard on messaging volume regardless
   of anything else in this doc.
3. **A WhatsApp Business Account (WABA)** under that Business Manager,
   with a phone number attached. Two paths:
   - **Migrate an existing WhatsApp Business App number** — the client
     already messages customers from this number today. Requires
     deleting the number from the WhatsApp Business mobile app first
     (Settings → Business tools → uninstall / or Delete Account for
     that number) — it cannot be registered in two places at once.
   - **Register a new number** — needs its own SIM/line capable of
     receiving an SMS or voice call for the one-time verification code;
     it cannot already be active on regular WhatsApp or WhatsApp
     Business.
4. **Two-step verification PIN** set on the WABA (Business Settings →
   WhatsApp Accounts) — required before production sending, and you'll
   need this PIN if the number is ever re-registered (server migration,
   disaster recovery).

## 2. Your Meta App

One Meta App can serve multiple clients' WABAs (each client's number is
added to your app's WhatsApp product) — decide up front whether you run
**one shared Meta App for all clients** or **one Meta App per client**.

- **Shared app** — faster to operate, one App Review to maintain. But
  every client's number lives behind the same App Secret/App ID, and
  Meta's per-app rate limits and any App Review restriction apply across
  all of them at once.
- **Per-client app** — isolates one client's traffic/quality problems
  from another's, cleanly hands off ownership if the client leaves. More
  App Review overhead if you're not using Tech Provider status (§6).

For anything beyond a couple of clients, use Tech Provider + one app
per client (§6) rather than deciding this manually each time.

Per app, in [developers.facebook.com](https://developers.facebook.com):

1. Create the app as type **Business**, attach it to the client's
   Business Manager (or your Tech Provider's, see §6).
2. Add the **WhatsApp** product. This gives you, under
   WhatsApp → API Setup:
   - **Temporary access token** (24h, for testing only — do not use in
     production)
   - **Phone number ID** and **WhatsApp Business Account ID**
   - A **test number** you can send/receive with immediately, before
     the client's real number is attached
3. **App Settings → Basic**: copy the **App ID** and **App Secret**.
   The App Secret is what `META_APP_SECRET` verifies every inbound
   webhook signature against — see
   [`src/lib/whatsapp/webhook-signature.ts`](../src/lib/whatsapp/webhook-signature.ts).
4. **Attach the client's real WABA/number**: WhatsApp → API Setup →
   "Add phone number" (if migrating/registering fresh) or the client
   grants your app access to their existing WABA via Business Manager
   → Business Settings → Accounts → WhatsApp Accounts → assign to your
   app/system user.
5. **Generate a permanent access token** — not the 24h one from step 2.
   Business Settings → Users → System Users → create a system user
   (role: Admin, or a scoped role with only `whatsapp_business_messaging`
   + `whatsapp_business_management`) → Generate Token, assign the WABA
   asset, select those two permissions, no expiration. This is the
   token that goes into `whatsapp_config.access_token` (this CRM
   encrypts it at rest — see §4).
6. **Move the app from Development to Live** (App Settings → top
   toggle). A Live app is required for anyone outside your app's
   Roles/Testers list to message the number, and is a prerequisite for
   requesting higher messaging tiers.

## 3. App Review — the permissions that actually gate production use

Development-mode apps can only message numbers explicitly added as
testers under Business Manager → Business Settings → Users. To message
the general public you need **App Review** approval for:

- `whatsapp_business_messaging` — send/receive messages
- `whatsapp_business_management` — manage templates, phone numbers,
  webhook config programmatically

Submit via App Review → Permissions and Features. You'll need a short
screencast showing the actual use case (agent replying to a customer in
your CRM's inbox) and a written use-case description. Budget several
business days for review; rejections are common on the first pass over
vague descriptions — be concrete about what the CRM does.

Until this is approved, the number is production-usable only for
testers, at Meta's lowest messaging tier — do not promise the client a
go-live date that assumes same-day approval.

## 4. Point Meta's webhook at this deployment

In your Meta App → WhatsApp → Configuration:

- **Callback URL**: `https://<client-deployment-host>/api/whatsapp/webhook`
- **Verify token**: any string you choose — it must match what's saved
  in this client's `whatsapp_config.verify_token` row (set from the
  dashboard's WhatsApp settings page,
  [`src/components/settings/whatsapp-config.tsx`](../src/components/settings/whatsapp-config.tsx)).
  Meta calls the callback URL with this token on save
  ([`GET` handler](../src/app/api/whatsapp/webhook/route.ts)) — it fails
  loudly if it doesn't match, so save the config in the CRM *before*
  clicking "Verify and Save" on Meta's side.
- **Webhook fields**: subscribe to `messages` at minimum. Also
  `message_template_status_update` if the client will use template
  messages (broadcasts) — the CRM's template lifecycle handler
  ([`src/lib/whatsapp/template-webhook.ts`](../src/lib/whatsapp/template-webhook.ts))
  depends on it to reflect Meta's approval/rejection state back into
  the dashboard.

Per-client / per-instance settings that get entered in **this CRM's**
dashboard (Settings → WhatsApp), not in Meta:

| Field | Where it comes from |
|---|---|
| Phone number ID | Meta App → WhatsApp → API Setup |
| WABA ID | Meta App → WhatsApp → API Setup |
| Access token | The permanent system-user token from §2 step 5 |
| Verify token | Your own chosen string, also set in Meta's webhook config |

The access token is AES-256-GCM encrypted at rest with `ENCRYPTION_KEY`
before it's stored — see [`src/lib/whatsapp/encryption.ts`](../src/lib/whatsapp/encryption.ts).
**`ENCRYPTION_KEY` must be identical across every instance/redeploy
that needs to decrypt existing tokens** — rotating it orphans every
client's saved token and forces them to re-enter it.

## 5. Multi-client deployment model — pick one deliberately

This affects almost everything above, so decide it before onboarding
your second client:

- **One shared CRM deployment, many accounts** (this repo's native
  model — `account_id` scopes every table, RLS enforces the boundary).
  Each client is an `account` row; each account's WhatsApp number is
  one `whatsapp_config` row. Cheapest to operate, but every client
  shares the same Cloud Run service's rate limits, uptime, and blast
  radius from a bad deploy.
- **One deployment per client** — full isolation, higher ops overhead
  (N sets of secrets, N Cloud Run services, N sets of Meta App
  credentials to track). Reasonable for clients paying enough to
  justify dedicated infra, or ones with compliance requirements that
  forbid multi-tenant storage.

Either way, one Meta App can still back multiple `whatsapp_config` rows
(§2's "shared app" option) — the deployment model and the Meta App
model are independent decisions.

## 6. Tech Provider status — do this once you have 3+ client apps

Meta's **Tech Provider** program (Business Manager → Business Settings
→ your business → apply as Tech Provider) is built for exactly this
"agency runs the same integration for many client businesses" shape:

- Lets you request `whatsapp_business_messaging` once at the Tech
  Provider level and inherit it into new client apps without a fresh
  App Review each time.
- Each client's WABA stays owned by the client's own Business Manager —
  you get delegated access via **Embedded Signup** or a shared system
  user, never full ownership. Cleaner offboarding if a client leaves.
- Required in practice once you're onboarding clients regularly; doing
  full App Review per client past the first few doesn't scale.

## 7. Messaging limits and quality — what determines them, per client

Each client's phone number has an independent **messaging tier**
(currently 250 / 1,000 / 10,000 / 100,000 business-initiated
conversations per rolling 24h) and **quality rating** (High/Medium/Low,
shown in WhatsApp Manager). Set expectations with the client:

- New numbers start at the lowest tier. Tier increases happen
  automatically based on sustained volume + quality, not on request.
- Quality rating drops from **block/report rates**, not from message
  volume — coach the client's agents on this explicitly: no cold
  outreach to numbers that haven't opted in, no template spam, honor
  opt-outs. A Low rating can suspend the number's ability to message
  new customers entirely.
- **Template messages** (used for `deliverBroadcast` — see
  [`src/lib/whatsapp/broadcast-core.ts`](../src/lib/whatsapp/broadcast-core.ts))
  each go through their own approval in WhatsApp Manager → Message
  Templates before they can be sent — separate from App Review, and
  typically much faster (minutes to hours), but budget time for it
  before the client's first broadcast campaign.
- The 24-hour **customer service window**: you can only send free-form
  (non-template) messages within 24h of the customer's last inbound
  message. Outside that window, only an approved template can reopen
  the conversation. This is enforced by Meta, not by this CRM — a send
  outside the window simply gets rejected by the API.

## 8. Go-live checklist (per client)

- [ ] Business verified in Business Manager (§1.2)
- [ ] Number registered/migrated, 2-step PIN set (§1.3–1.4)
- [ ] Permanent system-user access token generated with the two scoped
      permissions, not a personal/temporary token (§2.5)
- [ ] App is Live, not Development (§2.6)
- [ ] `whatsapp_business_messaging` + `whatsapp_business_management`
      approved via App Review, or inherited via Tech Provider (§3, §6)
- [ ] Webhook callback URL + verify token configured and verified
      against this client's `whatsapp_config` row (§4)
- [ ] `messages` and `message_template_status_update` webhook fields
      subscribed (§4)
- [ ] `ENCRYPTION_KEY`, `META_APP_SECRET`, `META_APP_VERIFY_TOKEN` set
      on the deployment this client's traffic actually hits (§4, and
      [deployment-gcp.md](deployment-gcp.md) for how those secrets get
      into Cloud Run)
- [ ] At least one message template submitted and approved, if the
      client plans to broadcast (§7)
- [ ] Client's agents briefed on the 24-hour window and quality-rating
      behavior (§7) — this prevents the most common "why can't I
      message this customer" support ticket
- [ ] Send + receive a real end-to-end test message through the CRM
      inbox on the client's actual number before declaring it live

## Related

- [deployment-gcp.md](deployment-gcp.md) — where `META_APP_SECRET`
  etc. get set as Cloud Run secrets
- [public-api.md](public-api.md) — if the client also wants
  programmatic access via `/api/v1`, separate from the dashboard
