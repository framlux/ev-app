FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
# tsconfig.base.json is not optional: every package tsconfig extends ../../tsconfig.base.json,
# and without it tsc fails with TS5083 only once the build stage runs - long after the
# install step that looks like the risky one. .npmrc carries link-workspace-packages.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json .npmrc ./
COPY packages/ packages/
COPY apps/web/ apps/web/
RUN pnpm install --frozen-lockfile
# `@ev/web...` means "this package AND its workspace dependencies", which is the
# whole point: naming @ev/core alone was correct only while the web app imported
# nothing else. It now queries Postgres through @ev/db, and a workspace package
# resolves to its dist/, so an unbuilt dependency fails at BUNDLE time with
# "Cannot find package '/app/apps/web/node_modules/@ev/db/dist/index.js'" - a
# message that reads like a broken install rather than a missing build step.
#
# The dependency-aware form does not need editing again the next time the web app
# takes on another workspace package, which is the failure this actually is: the
# build worked for months and broke when an import was added somewhere else.
RUN pnpm --filter @ev/web... build

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
COPY --from=build /app/apps/web/build ./build
COPY --from=build /app/apps/web/package.json ./
COPY --from=build /app/node_modules ./node_modules
USER 10001
EXPOSE 3000
CMD ["node", "build/index.js"]
