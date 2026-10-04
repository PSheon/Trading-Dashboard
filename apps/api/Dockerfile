# Build context: repository root. API/shared dependency closure only.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY patches patches
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @trading-dashboard/api...
COPY tsconfig.json ./
COPY apps/api apps/api
COPY packages/shared packages/shared
# Only the production closure can omit patches for development-only packages.
# Full installation still rejects unused patches; failed patch application is
# never allowed. Keep this exception scoped to the production deploy command.
RUN pnpm --filter @trading-dashboard/shared build \
 && pnpm --filter @trading-dashboard/api build \
 && pnpm --config.allowUnusedPatches=true --filter @trading-dashboard/api deploy --prod /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
# Release migration: docker run --rm -e DATABASE_URL IMAGE node scripts/migrate.mjs
CMD ["node", "dist/main.js"]
