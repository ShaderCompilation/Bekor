# Bekor

Spaced-repetition practice for small JavaScript and TypeScript function problems. Learners solve a problem, the server judges it in an isolated Judge0 sandbox, and the server schedules reviews (FSRS). The browser and CLI clients will use the same API.

Scope, architecture, task status and acceptance criteria live in [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

## Status

| Area                                                                                              | State                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API (`apps/api`, Hono), persistence (`packages/db`, Drizzle/PostgreSQL), catalog/content, reviews | Implemented, covered by unit and real-PostgreSQL integration tests                                                                                                    |
| Judging worker (`apps/worker`, pg-boss) and Judge0 adapter (`packages/runner`)                    | Implemented and tested against a **fake** runner only                                                                                                                 |
| Real Judge0 execution                                                                             | **Not verified.** The Fedora dev host (cgroup v2, rootless Podman) cannot run Judge0 1.13.1. See [`docs/verification/f03-runner.md`](docs/verification/f03-runner.md) |
| Web app (`apps/web`) and CLI (`apps/cli`)                                                         | Not implemented yet                                                                                                                                                   |
| Deployment                                                                                        | None. `infra/compose` is for local development only                                                                                                                   |

## Prerequisites

- Node.js **24.22.1** (`.node-version`; pnpm's `devEngines` downloads it if your Node differs)
- pnpm **12.14.0** (`packageManager` in `package.json`; `corepack enable` or `npm i -g pnpm@12.14.0`)
- Podman with `podman compose` (needs a compose provider such as `podman-compose` or `docker-compose`), or Docker with Compose v2

## Getting started

```bash
pnpm install
cp .env.example .env
# Set BETTER_AUTH_SECRET to at least 32 random characters, e.g. `openssl rand -base64 32`.
```

### Database

Start only PostgreSQL (published on `127.0.0.1:55432` by default), then apply migrations from the host:

```bash
podman compose -f infra/compose/compose.yaml --env-file .env up -d postgres
pnpm db:migrate        # uses DATABASE_URL from your shell; e.g.
DATABASE_URL=postgresql://bekor:bekor@127.0.0.1:55432/bekor pnpm db:migrate
```

### API and worker from the host

Both processes validate their environment on startup and print one message listing every missing or invalid variable (values are never printed).

```bash
pnpm --filter @bekor/api exec tsx --env-file=../../.env src/main.ts      # GET http://localhost:3000/health
pnpm --filter @bekor/worker exec tsx --env-file=../../.env src/main.ts   # needs a private JUDGE0_URL
```

The worker refuses to start without `JUDGE0_URL`. Without a worker, the API still accepts runs/submissions; they stay `queued` and are picked up (recovery requeues them) once a worker runs. With `WORKER_HEALTH_PORT` set, the worker serves `GET /health` (database reachability, not draining).

### Everything in containers

```bash
# postgres + migrate + api (http://localhost:3000)
podman compose -f infra/compose/compose.yaml --env-file .env up -d --build

# + worker using an external private Judge0 (set JUDGE0_URL in .env)
podman compose -f infra/compose/compose.yaml --env-file .env --profile worker up -d

# + worker + bundled Judge0 (privileged; needs a rootful engine on a cgroup v1 host)
podman compose -f infra/compose/compose.yaml --env-file .env --profile runner up -d --build
```

The `runner` profile is opt-in on purpose: Judge0 runs privileged containers and requires cgroup v1. It sits on an internal network that only the worker joins; the API cannot reach it, and it has no outbound route. Read [`docs/decisions/runner.md`](docs/decisions/runner.md) before enabling it.

## Checks

```bash
pnpm lint                  # Biome + package boundary check
pnpm typecheck
pnpm test                  # unit tests (no database, no runner)
pnpm content:validate      # exercise packages
pnpm test:integration      # real PostgreSQL; skipped unless TEST_DATABASE_URL is set
pnpm test:runner           # real Judge0; skipped unless JUDGE0_URL is set
```

`TEST_DATABASE_URL` is an admin connection; each suite creates and drops its own throwaway database, so the role needs `CREATEDB`:

```bash
TEST_DATABASE_URL=postgresql://bekor:bekor@127.0.0.1:55432/postgres pnpm test:integration
```

Worker integration tests use a **fake** runner and verify persistence/recovery, not execution. Only `pnpm test:runner` against a private Judge0 built from `infra/compose/judge0` verifies real execution. Never point it at a public Judge0 endpoint.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests, content validation, migrations and integration tests against a PostgreSQL service. The real-runner job is a placeholder for a self-hosted Judge0 machine and has not run.

## Runbooks

- [`docs/runbooks/development.md`](docs/runbooks/development.md): local setup details and troubleshooting
- [`docs/runbooks/judging-recovery.md`](docs/runbooks/judging-recovery.md): stuck or failed submissions, leases, retries and safe requeueing
