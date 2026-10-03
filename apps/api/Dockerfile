# Production image for the API. Build from the repository root:
#   docker build -f apps/api/Dockerfile --target api .
# Targets:
#   api      the running service (production dependencies only)
#   migrate  one-off jobs: `prisma migrate deploy` (default command) and the demo seed

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @nolon/api... --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @nolon/shared build \
 && pnpm --filter @nolon/api build \
 && pnpm --filter @nolon/api deploy --legacy --prod --ignore-scripts /out/prod \
 && pnpm --filter @nolon/api deploy --legacy /out/full \
 && for dir in /out/prod /out/full; do rm -rf "$dir/dist" && cp -r apps/api/dist "$dir/dist"; done

FROM node:22-alpine AS migrate
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/full ./
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

FROM node:22-alpine AS api
ENV NODE_ENV=production PORT=4000
WORKDIR /app
COPY --from=build /out/prod ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
