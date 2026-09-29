# apps/api Dockerfile — Railway (§7). Build context is the REPO ROOT
# (pnpm workspace), not apps/api, because the api depends on
# packages/shared. On Railway, set the service's root directory to "/" and
# point it at this file (see railway.json).

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# ---------------------------------------------------------------------------
# deps: install once, cached as long as lockfile + package.json files match
# ---------------------------------------------------------------------------
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build: shared (dist/*.js the api imports at runtime) then the api itself
# ---------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @trading-dashboard/shared build
RUN pnpm --filter @trading-dashboard/api build

# ---------------------------------------------------------------------------
# runtime: only what's needed to run `node dist/main.js`
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app

# pnpm's node_modules are symlink trees pointing back into the root
# node_modules/.pnpm store, so that store plus each package's own
# node_modules/ (the symlinks) all need to come along, keeping the same
# relative layout as the build stage.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist

EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
