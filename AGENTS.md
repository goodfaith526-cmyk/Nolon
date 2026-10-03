# AGENTS.md

Rules for any AI coding agent (Claude Code, Codex, ...) and any human working in this repository.
The rules in **Non-negotiable rules** are not style preferences. A change that breaks one of them
is rejected in review, however good the rest of it is.

## Project

NOLON: ERP + TMS for NOLON Logistics (branches DXB, JED, PTS, ATB, KRT). Web only, Arabic + English.
Phase 1 is "AI-ready": a permissioned API that a customer-service AI agent will call later.

## Layout

```
apps/api         NestJS API (the only code that touches the database)
  prisma/        schema.prisma + migrations (raw SQL lives in migrations, reviewed by a human)
  src/<module>/  one folder per business module: controller, service, module, *.spec.ts
  test/          integration tests (*.int-spec.ts) against a real PostgreSQL
apps/web         Next.js App Router, ar (RTL, default) / en (LTR) under /[locale]
packages/shared  Types and constants shared by api and web (no runtime deps, no DB code)
```

Modular monolith: modules talk to each other through exported services, never by reaching into
another module's tables or internals.

## Non-negotiable rules

1. **Money is Decimal, only.** Database columns use `Decimal` (`@db.Decimal(18, 4)`; FX rates
   `@db.Decimal(18, 8)`). In TypeScript use `Prisma.Decimal`. Never `Float`, never JS `number`,
   never `parseFloat`/`Number()` on an amount. Amounts cross the API as decimal strings
   (`DecimalString` in `@nolon/shared`). Rounding is explicit and done in one place.
2. **Every query is branch-scoped.** Any read or write of branch-owned data filters on
   `branchId` taken from the authenticated user's allowed branches, never from an unchecked
   request field. Cross-branch access exists only for roles that hold an explicit permission
   for it. Forgetting the filter is a data leak, not a bug.
3. **Posted journal entries are immutable.** Once a journal entry is posted, it and its lines
   cannot be updated or deleted. This is enforced in PostgreSQL by triggers written as raw SQL
   inside a migration, not only in application code. Corrections are made with a reversing
   entry. Never drop, disable or bypass these triggers.
4. **No migration without review.** Migrations are generated with `pnpm db:migrate`, committed,
   and reviewed by a human before merge (CODEOWNERS enforces it). Never edit or delete a
   migration that is already on `main`; add a new one. Call out destructive or locking changes
   (drops, renames, type changes, new NOT NULL on existing tables) in the PR description.
5. **No business logic in controllers or in Next.js.** Controllers parse, validate, authorize,
   call one service method and map the result. Rules, calculations, state transitions and
   posting live in services. `apps/web` renders and calls the API; it decides nothing.
6. **No direct database access from the UI or the AI agent.** Only `apps/api` imports Prisma or
   connects to PostgreSQL (lint enforces this for `apps/web`). The AI agent reaches data only
   through the Customer Service API with its own permissions, like any other client.
7. **Every financial or permission feature ships with tests.** Unit tests for the rules and
   integration tests against PostgreSQL, including the negative cases: wrong branch, missing
   permission, unbalanced entry, editing a posted entry.

## Other rules

- TypeScript strict everywhere. No `any`, no `@ts-ignore`, no `eslint-disable` without a comment
  explaining why.
- Every user-facing string goes in both `apps/web/messages/ar.json` and `en.json` (a test checks
  they have the same keys). Use logical CSS properties (`margin-inline`, `padding-inline-start`)
  so layouts work in RTL and LTR.
- Shipment status changes go through the shipment state machine; journal entries come from the
  auto-journal rules service. Neither is written ad hoc inside another module.
- Writes that must succeed or fail together (e.g. an invoice and its journal entry) run in one
  `prisma.$transaction`.
- In `apps/api`, keep injected classes as value imports (not `import type`): Nest resolves
  constructor dependencies from emitted metadata.
- Secrets never go in the repository. Configuration comes from environment variables, validated
  at startup in `apps/api/src/config/env.ts`.
- Do only the task you were given. No extra features, refactors or dependencies outside its
  scope; propose them separately.

## How to work

1. One small task at a time, with clear acceptance criteria.
2. Before writing code, state the plan and any database changes (models, migration, triggers).
3. Implement with tests.
4. Before opening a PR, run and pass:
   ```sh
   pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
   pnpm db:check && pnpm test:integration   # needs the local database
   ```
5. Open a PR. CI must be green; a human reviews the diff and merges to `main`.

## Commands

| Command                 | What it does                                          |
| ----------------------- | ----------------------------------------------------- |
| `pnpm db:up`            | Start local PostgreSQL (docker compose)               |
| `pnpm db:migrate`       | Create/apply a migration from `schema.prisma` (dev)   |
| `pnpm db:deploy`        | Apply committed migrations                            |
| `pnpm db:check`         | Fail if `schema.prisma` and the database have drifted |
| `pnpm dev`              | Run api (:4000) and web (:3000) in watch mode         |
| `pnpm lint`             | ESLint (type-aware)                                   |
| `pnpm typecheck`        | `tsc --noEmit` in every package                       |
| `pnpm test`             | Unit tests (no database)                              |
| `pnpm test:integration` | API integration tests against PostgreSQL              |
