# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Meta CRM — production image
#
# Three stages: install deps, build (with the `output: "standalone"` trace
# from next.config.ts), then a minimal runtime image that only carries the
# standalone server + static assets. See
# node_modules/next/dist/docs/01-app/01-getting-started/17-deploying.md
# and the "Docker" section of the self-hosting guide.
# ---------------------------------------------------------------------------

ARG NODE_VERSION=22-alpine

# ---- deps -------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# ---- build --------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* vars are inlined into the client bundle at build time, so
# they must be passed as build args (not runtime env vars). Everything
# else (Supabase service-role key, encryption key, Meta secrets) is
# server-only and injected at deploy time — never baked into the image.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_APP_LOCALE=en
ARG SUPABASE_SERVICE_ROLE_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_APP_LOCALE=$NEXT_PUBLIC_APP_LOCALE \
    NEXT_TELEMETRY_DISABLED=1 \
    SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY

# Fail fast with a clear message instead of a cryptic Supabase stack
# trace ~20s into `next build`: several client components (e.g.
# forgot-password) construct a Supabase client at module scope, and
# Next 16 prerenders client components too, so a missing/empty URL or
# anon key breaks the build, not just runtime.
RUN if [ -z "$NEXT_PUBLIC_SUPABASE_URL" ] || [ -z "$NEXT_PUBLIC_SUPABASE_ANON_KEY" ]; then \
      echo "ERROR: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY build args are required (pass via --build-arg, or set the GitHub Actions repo/environment Variables — see docs/deployment-gcp.md)." >&2; \
      exit 1; \
    fi

RUN npm run build

# ---- runtime --------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=8080

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# Standalone output already contains a pruned node_modules + server.js;
# static assets and public files are copied on top of it.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

# Cloud Run injects $PORT; server.js (standalone output) honours it.
EXPOSE 8080

CMD ["node", "server.js"]
