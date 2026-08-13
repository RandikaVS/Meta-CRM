# Deploying to Google Cloud Run

The app ships as a `output: "standalone"` Next.js build ([`next.config.ts`](../next.config.ts))
packaged by [`Dockerfile`](../Dockerfile), and deployed via
[`.github/workflows/deploy-gcp.yml`](../.github/workflows/deploy-gcp.yml)
on every push to `main` (production) or `dev` (staging).

## One-time GCP setup

```bash
export GOOGLE_PROJECT=<your-project-id>
export GOOGLE_REGION=us-west2   # or your preferred region

gcloud config set project "$GOOGLE_PROJECT"

# APIs the pipeline needs
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com

# Artifact Registry repo for built images
gcloud artifacts repositories create meta-crm-repo \
  --repository-format=docker \
  --location="$GOOGLE_REGION"

# Deploy service account — least privilege, no owner/editor role
gcloud iam service-accounts create meta-crm-deployer \
  --display-name="Meta CRM CI deployer"

for role in roles/run.admin roles/artifactregistry.writer roles/iam.serviceAccountUser roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$GOOGLE_PROJECT" \
    --member="serviceAccount:meta-crm-deployer@${GOOGLE_PROJECT}.iam.gserviceaccount.com" \
    --role="$role"
done

gcloud iam service-accounts keys create key.json \
  --iam-account="meta-crm-deployer@${GOOGLE_PROJECT}.iam.gserviceaccount.com"
```

Store the **raw contents** of `key.json` as the `GOOGLE_APPLICATION_CREDENTIALS`
GitHub secret — `google-github-actions/auth@v2`'s `credentials_json`
input takes the service-account JSON directly, no encoding needed:

```bash
gh secret set GOOGLE_APPLICATION_CREDENTIALS < key.json
# no gh CLI? Settings → Secrets and variables → Actions → New repository
# secret, then paste the full contents of key.json
rm key.json
```

If pasting the multi-line JSON through the GitHub web UI ever produces
`Error: ... failed to parse service account key JSON credentials: bad
control character in string literal`, the UI mangled the escaped `\n`
sequences inside the PEM private key on paste — use `gh secret set`
(above) instead, which sends the file content byte-for-byte and avoids
that. Do **not** base64-encode the value; `credentials_json` expects
JSON as-is. (If your org requires Workload Identity Federation instead
of long-lived JSON keys, swap the `auth` step's `credentials_json` for
`workload_identity_provider` — no other changes needed.)

## Secrets in Secret Manager

Server-only secrets are injected into the Cloud Run service at deploy
time via `--set-secrets`, never baked into the image or passed through
the workflow's plaintext env vars. Create one secret per required
server variable (see [.env.local.example](../.env.local.example) for
what each does):

```bash
for name in SUPABASE_SERVICE_ROLE_KEY ENCRYPTION_KEY META_APP_SECRET META_APP_VERIFY_TOKEN; do
  gcloud secrets create "$name" --replication-policy=automatic
done

echo -n "<value>" | gcloud secrets versions add SUPABASE_SERVICE_ROLE_KEY --data-file=-
echo -n "<value>" | gcloud secrets versions add ENCRYPTION_KEY --data-file=-
echo -n "<value>" | gcloud secrets versions add META_APP_SECRET --data-file=-
echo -n "<value>" | gcloud secrets versions add META_APP_VERIFY_TOKEN --data-file=-
```

## GitHub configuration

**Repo secrets** (Settings → Secrets and variables → Actions → Secrets):

| Secret | Value |
|---|---|
| `GOOGLE_PROJECT` | your GCP project ID |
| `GOOGLE_APPLICATION_CREDENTIALS` | contents of `key.json` |

**Repo/environment variables** (same page → Variables — not secret,
these get inlined into the client bundle at build time or are plain
runtime config):

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL — **required**, see below |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key — **required**, see below |
| `GOOGLE_REGION` | defaults to `us-west2` if unset |
| `PROD_NEXT_PUBLIC_SITE_URL` | canonical URL of the `main` deploy |
| `DEV_NEXT_PUBLIC_SITE_URL` | canonical URL of the `dev` deploy |

> `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` aren't
> just for runtime — they're passed as Docker **build args** and get
> compiled into the client bundle by `next build`. Several client
> components construct a Supabase client at module scope, and Next 16
> prerenders client components too, so if these are missing or empty
> the image **fails to build**, not just to run. The Dockerfile checks
> for this and fails fast with a clear error rather than the raw
> `@supabase/ssr: Your project's URL and API key are required` stack
> trace. If you hit that error, these two variables aren't set (or
> aren't set on the environment — `production`/`development` — the
> workflow run used).

The workflow defines two GitHub **Environments**, `production` (for
pushes to `main`) and `development` (for pushes to `dev`) — use
per-environment variables/secrets if the two deployments point at
different Supabase projects or WhatsApp numbers, or required reviewers
on `production` if you want a manual approval gate before prod
deploys.

## What the workflow does

1. Checks out the code and authenticates to GCP.
2. Builds the Docker image, passing the `NEXT_PUBLIC_*` values as
   build args (they're inlined into the client bundle, so they must be
   present at `next build` time — see the comments in `Dockerfile`).
3. Pushes the image to Artifact Registry, tagged with the commit SHA
   and a timestamp (unique, traceable, rollback-able).
4. Deploys to Cloud Run:
   - `main` → `meta-crm-service-prod`, `min-instances=1` (no cold
     start on the production webhook endpoint).
   - `dev` → `meta-crm-service-dev`, `min-instances=0` (scales to
     zero, cheaper for a staging environment).
   - Server-only secrets are wired from Secret Manager via
     `--set-secrets`.
   - `--allow-unauthenticated` is required — the WhatsApp webhook and
     the public UI both need to be reachable without Google IAM auth.
     Cloud Run + HTTPS is the perimeter; the app itself verifies the
     Meta webhook signature with `META_APP_SECRET` and gates
     everything else behind Supabase Auth.

## Production checklist

- [ ] Custom domain mapped to the Cloud Run service (`gcloud run
      domain-mappings create`) with `NEXT_PUBLIC_SITE_URL` matching it.
- [ ] Supabase migrations applied (see [README.md](../README.md#database-setup)).
- [ ] Meta webhook URL set to `https://<your-domain>/api/whatsapp/webhook`
      (or the app's actual webhook route) with `META_APP_VERIFY_TOKEN`
      matching Secret Manager.
- [ ] `ENCRYPTION_KEY` generated once and never rotated without a plan
      for re-saving every account's WhatsApp settings.
- [ ] `WHATSAPP_TEMPLATES_DRY_RUN` unset (or `false`) in production.
- [ ] Cloud Run min-instances >= 1 on prod to avoid cold-start latency
      on inbound webhook calls.
