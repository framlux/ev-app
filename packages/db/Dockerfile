FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
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
