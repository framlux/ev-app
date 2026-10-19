FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
# tsconfig.base.json is not optional: every package tsconfig extends ../../tsconfig.base.json,
# and without it tsc fails with TS5083 only once the build stage runs - long after the
# install step that looks like the risky one. .npmrc carries link-workspace-packages.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json .npmrc ./
COPY packages/ packages/
COPY apps/rivian/ apps/rivian/
RUN pnpm install --frozen-lockfile
# No @ev/tesla: nothing the connector imports depends on it. @ev/rivian needs @ev/core, and
# @ev/db is how the connector reads the credential and writes its status.
RUN pnpm --filter @ev/core build \
 && pnpm --filter @ev/rivian build \
 && pnpm --filter @ev/db build \
 && pnpm --filter @ev/rivian-connector build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Numeric UID, not a name. The kubelet never reads the image's /etc/passwd, so it
# cannot verify that a named USER is non-root: a pod with runAsNonRoot: true and no
# runAsUser is REFUSED outright with "image has non-numeric user (app), cannot verify
# user is non-root". The container never starts, so the failure lands at deploy time,
# not build time. USER 10001 makes the image self-sufficient regardless of what the
# manifest sets.
RUN addgroup -S -g 10001 app && adduser -S -u 10001 -G app app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
# apps/rivian carries its own node_modules of workspace symlinks into ../../packages,
# so it is copied whole rather than dist-only.
COPY --from=build /app/apps/rivian ./apps/rivian
USER 10001
# Prometheus scrapes this; there is no HTTP service otherwise.
EXPOSE 9090
CMD ["node", "apps/rivian/dist/main.js"]
