# syntax=docker/dockerfile:1
# model-verity — verify third-party AI service claims.
# Build produces a self-contained dist; runtime needs only node_modules + dist.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# keytar (system keychain) is optional; containers use the encrypted-file backend.
# better-sqlite3 compiles from source on slim, so the build stage needs a toolchain.
# Keep optional deps during install: rollup ships its platform binary as an
# optional dependency and the vite build needs it. keytar failing is tolerated.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && npm ci
COPY . .
RUN npm run build && npm prune --omit=dev --omit=optional

FROM node:22-slim
ENV NODE_ENV=production \
    XDG_CONFIG_HOME=/data \
    MODEL_VERITY_DISABLE_KEYCHAIN=1
WORKDIR /app
COPY --from=build /app/package.json /app/LICENSE /app/README.md ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 8787
# The app has no built-in login; bind 0.0.0.0 inside the container and put an
# authenticated HTTPS reverse proxy in front of the published port.
ENTRYPOINT ["node", "dist/cli/index.js", "start", "--host", "0.0.0.0", "--port", "8787"]
