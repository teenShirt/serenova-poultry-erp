# syntax=docker/dockerfile:1.7
# Production image: build in one stage, run from a small non-root image with production packages only.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --omit=optional

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    METRICS_PORT=9100 \
    BACKUP_DIR=/data/backups
WORKDIR /app
# tini forwards SIGTERM so the server shuts down cleanly when Kubernetes stops the pod.
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/backups && chown -R node:node /data
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/resources ./resources
ARG RELEASE_SHA=""
ENV RELEASE_SHA=${RELEASE_SHA}
USER node
EXPOSE 3000 9100
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/index.js"]
