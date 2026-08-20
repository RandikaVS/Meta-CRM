# Meta CRM

Self-hostable CRM for WhatsApp — shared inbox, contacts, sales
pipelines, broadcasts, and no-code automations. Built on Next.js and
Supabase.

## Prerequisites

- Node.js >= 20 ([`.nvmrc`](./package.json) — see `engines`)
- npm
- A [Supabase](https://supabase.com) project (Postgres + Auth + Storage)
- A Meta for Developers app with WhatsApp Business API access

## Project setup

```bash
git clone <this-repo-url>
cd Meta-CRM
npm install
cp .env.local.example .env.local
```

Fill in `.env.local`:

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Server-only, bypasses RLS — keep secret |
| `ENCRYPTION_KEY` | ✅ | 64 hex chars: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `META_APP_SECRET` | ✅ | Meta for Developers → App Settings → Basic |
| `META_APP_VERIFY_TOKEN` | ✅ | Any string you choose; used to verify the webhook |
| `NEXT_PUBLIC_SITE_URL` | Recommended | Canonical public URL of this deployment |
| `NEXT_PUBLIC_APP_LOCALE` | Recommended | Default locale, e.g. `en` |

The rest of the variables in `.env.local.example` are optional and only
needed for specific features (AI reply assistant, webhook cron, image
message templates). Each one is documented inline in that file.

Start the dev server:

```bash
npm run dev
```

Open <http://localhost:3000>. You'll be redirected to `/login` (or
`/dashboard` if already signed in).

Other useful scripts:

```bash
npm run build       # production build
npm run start       # run the production build locally
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm run test         # vitest
```

## Database setup

The schema lives entirely in [`supabase/migrations`](./supabase/migrations)
as sequential, numbered SQL files (`001_initial_schema.sql`,
`002_pipelines_enhancements.sql`, …). Apply them in order, on top of a
fresh Supabase project.

### Option A — Supabase CLI (recommended)

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

`db push` applies every migration under `supabase/migrations` that
hasn't been run yet, in filename order.

### Option B — Supabase Dashboard SQL editor

If you don't want to install the CLI, open **SQL Editor** in your
Supabase project and run each file in `supabase/migrations` in numeric
order, oldest first. Do not skip files or run them out of order —
later migrations assume earlier ones already ran.

### After migrating

- Enable the `pgvector` extension if you want semantic search for the
  AI knowledge base (migration `030_ai_knowledge.sql` already runs
  `CREATE EXTENSION IF NOT EXISTS vector`, so this is normally
  automatic on Supabase).
- Row Level Security is enabled on every table by the migrations —
  don't disable it.
- When you add your own migrations, keep the `NNN_description.sql`
  numbering sequential so `db push` and the SQL-editor path stay in
  order.

## Deployment

Production deployment (Docker + Google Cloud Run via GitHub Actions)
is documented in [`docs/deployment-gcp.md`](./docs/deployment-gcp.md).

gcloud secrets create SUPABASE_SERVICE_ROLE_KEY \
  --replication-policy=automatic

printf '%s' 'YOUR_NEW_SERVICE_ROLE_KEY' | \
gcloud secrets versions add SUPABASE_SERVICE_ROLE_KEY \
  --data-file=-

gcloud secrets add-iam-policy-binding SUPABASE_SERVICE_ROLE_KEY \
--member="serviceAccount:335587238445-compute@developer.gserviceaccount.com" \
--role="roles/secretmanager.secretAccessor"

for name in ENCRYPTION_KEY META_APP_SECRET META_APP_VERIFY_TOKEN; do
  gcloud secrets add-iam-policy-binding "$name" \
    --member="serviceAccount:335587238445-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done


## License

[MIT](./LICENSE).

## Todo 

Service packages Adding  (50%) done


                         GitHub
                            │
                            ▼
                     GitHub Actions
                            │
              ┌─────────────┴─────────────┐
              │                           │
             CI                     Build Docker
              │                           │
       tests/typecheck/lint               │
              │                           ▼
              │                    Artifact Registry
              │                           │
              └──────────────┬────────────┘
                             │
                             ▼
                      DB Migration Job
                             │
                ┌────────────┼────────────┐
                ▼            ▼            ▼
              DB A         DB B         DB C
                │            │            │
                └────────────┼────────────┘
                             │
                             ▼
                        Cloud Run
                  ┌──────────┼──────────┐
                  ▼          ▼          ▼
               Client A   Client B   Client C
                  │          │          │
                  ▼          ▼          ▼
               Meta A     Meta B     Meta C




