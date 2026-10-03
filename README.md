# NOLON

ERP + TMS for NOLON Logistics. pnpm monorepo, modular monolith:

- `apps/api`: NestJS + Prisma + PostgreSQL
- `apps/web`: Next.js, Arabic (RTL, default) and English (LTR)
- `packages/shared`: shared types and constants

Rules for contributors and AI agents: [AGENTS.md](./AGENTS.md).

## Requirements

Node 22+, pnpm 10 (`corepack enable`), Docker.

## Local setup

```sh
pnpm install
cp .env.example apps/api/.env
pnpm db:up                              # PostgreSQL 16 on localhost:5432
pnpm db:deploy                          # apply migrations
pnpm db:seed                            # optional: demo data (the 5 branches)
pnpm dev                                # api on :4000, web on :3000
```

- Web: http://localhost:3000 (redirects to `/ar`; `/en` for English)
- API health: http://localhost:4000/api/v1/health

## Checks

```sh
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
pnpm db:check && pnpm test:integration
```

CI runs the same on every pull request. Changes reach `main` only through a reviewed PR with
green CI.

## Staging

Every push to `main` that passes CI is deployed to the staging server. Setup: [DEPLOY.md](./DEPLOY.md).
