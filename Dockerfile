# syntax=docker/dockerfile:1.7
# ── Bulkhead · single image serving the API and the built console ──────────────
FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/airwallex/package.json packages/airwallex/
COPY packages/agent/package.json packages/agent/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @bulkhead/web build

FROM node:24-slim AS runtime
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 BULKHEAD_DATA_DIR=/data AIRWALLEX_MODE=simulator
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]
