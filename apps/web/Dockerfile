FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/ packages/
COPY apps/web/ apps/web/
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ev/core build
RUN pnpm --filter @ev/web build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /app/apps/web/build ./build
COPY --from=build /app/apps/web/package.json ./
COPY --from=build /app/node_modules ./node_modules
USER app
EXPOSE 3000
CMD ["node", "build/index.js"]
