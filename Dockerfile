# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Stamp the commit SHA so Sentry tags errors with the same release id we
# upload sourcemaps for in CI. Passed via `flyctl deploy --build-arg`.
# Defaults to "dev" so a manual `docker build` without --build-arg still works.
ARG SENTRY_RELEASE=dev
ENV SENTRY_RELEASE=$SENTRY_RELEASE

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# /data is the persistent volume mount in fly.toml. sign-store and audit log
# both write here so a redeploy doesn't lose pending sigs or audit history.
# NOTE: still runs as root. Fly's firecracker VMs isolate us, but moving to
# the `node` user is a backlog item — requires migrating the existing volume
# (files owned by root from prior deploys would become unwritable). To switch
# safely: add a tini/su-exec entrypoint that chowns /data at runtime.
RUN mkdir -p /data
ENV SIGN_STORE_PATH=/data/sign-store.json
ENV AUDIT_LOG_PATH=/data/audit.log
ENV AUTH_STORE_PATH=/data/api-keys.json

EXPOSE 3030
CMD ["node", "dist/server/index.js"]
