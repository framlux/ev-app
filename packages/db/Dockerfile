FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
# tsconfig.base.json is not optional: every package tsconfig extends ../../tsconfig.base.json,
# and without it tsc fails with TS5083 only once the build stage runs - long after the
# install step that looks like the risky one. .npmrc carries link-workspace-packages.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json .npmrc ./
COPY packages/ packages/
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ev/core build && pnpm --filter @ev/db build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
USER app
CMD ["node", "packages/db/dist/migrate.js"]
