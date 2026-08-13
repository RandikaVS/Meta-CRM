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

`key.json` is the credential you paste into the
`GOOGLE_APPLICATION_CREDENTIALS` GitHub secret below — delete the local
copy afterwards. (If your org requires Workload Identity Federation
instead of long-lived JSON keys, swap the `auth` step in the workflow
for `google-github-actions/auth@v2` with `workload_identity_provider`
— no other changes needed.)

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
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `GOOGLE_REGION` | defaults to `us-west2` if unset |
| `PROD_NEXT_PUBLIC_SITE_URL` | canonical URL of the `main` deploy |
| `DEV_NEXT_PUBLIC_SITE_URL` | canonical URL of the `dev` deploy |

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
