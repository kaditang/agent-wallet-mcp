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

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# /data is the persistent volume mount in fly.toml. sign-store and audit log
# both write here so a redeploy doesn't lose pending sigs or audit history.
RUN mkdir -p /data
ENV SIGN_STORE_PATH=/data/sign-store.json
ENV AUDIT_LOG_PATH=/data/audit.log

EXPOSE 3030
CMD ["node", "dist/server/index.js"]
