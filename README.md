# Bekor

Spaced-repetition practice for small JavaScript and TypeScript function problems. Learners solve a problem, the server judges it in an isolated Judge0 sandbox, and the server schedules reviews (FSRS). The browser and CLI clients will use the same API.

Scope, architecture, task status and acceptance criteria live in [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

## Status

| Area                                                                                              | State                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API (`apps/api`, Hono), persistence (`packages/db`, Drizzle/PostgreSQL), catalog/content, reviews | Implemented, covered by unit and real-PostgreSQL integration tests                                                                                                                               |
| Judging worker (`apps/worker`, pg-boss) and Judge0 adapter (`packages/runner`)                    | Implemented and tested against a **fake** runner only                                                                                                                                            |
| Development Podman runner (`RUNNER=podman`, personal use only)                                    | Real execution in local rootless containers; passes `pnpm test:runner`. Weaker isolation than production, see [`docs/verification/f05-podman-runner.md`](docs/verification/f05-podman-runner.md) |
| Real Judge0 execution                                                                             | **Not verified.** The Fedora dev host (cgroup v2, rootless Podman) cannot run Judge0 1.13.1. See [`docs/verification/f03-runner.md`](docs/verification/f03-runner.md)                            |
| Web app (`apps/web`, React/Vite/TanStack Router+Query/Zustand/Monaco)                             | Implemented; Playwright journeys pass against the real API/worker/PostgreSQL with the Podman runner. See [`docs/verification/web.md`](docs/verification/web.md)                                  |
| CLI (`apps/cli`)                                                                                  | Not implemented yet                                                                                                                                                                              |
| Deployment                                                                                        | None. `infra/compose` is for local development only                                                                                                                                              |

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
pnpm --filter @bekor/worker exec tsx --env-file=../../.env src/main.ts   # needs RUNNER=podman or a private JUDGE0_URL
```

For personal use, run the worker on the host with the development Podman runner (the worker calls the `podman` CLI, so it must run on the host, not in the compose `worker` service):

```bash
podman build -t localhost/bekor-runner:node24.22.1-ts7.0.2 infra/runner   # once
# in .env: RUNNER=podman
```

Each execution runs in its own rootless container: no network, read-only root filesystem, no host files, memory/CPU/process limits, and none of the worker's environment. It shares the host kernel, so it is **not** production isolation; the worker refuses `RUNNER=podman` when `NODE_ENV=production`.

With the default `RUNNER=judge0`, the worker refuses to start without `JUDGE0_URL`. Without a worker, the API still accepts runs/submissions; they stay `queued` and are picked up (recovery requeues them) once a worker runs. With `WORKER_HEALTH_PORT` set, the worker serves `GET /health` (database reachability, not draining).

### Web app

The SPA and API share one origin: Vite (`http://localhost:5173`) proxies `/api`, `/auth` and `/health` to the API on port 3000. Because cookie sessions and the API's Origin check use `API_ORIGIN`, set it to the Vite origin while developing the web app:

```bash
# in .env: API_ORIGIN=http://localhost:5173   (and REGISTRATION_ENABLED=true to create an account)
pnpm dev:web                 # http://localhost:5173; start the API (and worker) as above
```

`BEKOR_API_PROXY` overrides the proxy target. `pnpm --filter @bekor/web build` writes static files to `apps/web/dist`; serving them on the API's origin in production is not set up yet.

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
pnpm test:runner           # real runner; skipped unless JUDGE0_URL or BEKOR_PODMAN_RUNNER=1 is set
pnpm check:web-bundle      # after building apps/web: no reference solutions/private tests in the bundle
pnpm test:e2e              # Playwright against a running stack (BEKOR_E2E_URL, default http://localhost:5173)
```

`pnpm test:e2e` needs the web dev server, API (`API_ORIGIN=http://localhost:5173`, `REGISTRATION_ENABLED=true`), a worker with a real runner and a migrated database already running; it starts nothing itself. Install the browser once with `pnpm exec playwright install chromium`. It signs up two accounts per run, so rerunning within a minute can hit the sign-up rate limit.

`TEST_DATABASE_URL` is an admin connection; each suite creates and drops its own throwaway database, so the role needs `CREATEDB`:

```bash
TEST_DATABASE_URL=postgresql://bekor:bekor@127.0.0.1:55432/postgres pnpm test:integration
```

Worker integration tests use a **fake** runner and verify persistence/recovery, not execution. `BEKOR_PODMAN_RUNNER=1 pnpm test:runner` verifies real execution in the development Podman runner; only `pnpm test:runner` against a private Judge0 built from `infra/compose/judge0` verifies the production runner. Never point it at a public Judge0 endpoint.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests, content validation, the web production build with the bundle check, migrations and integration tests against a PostgreSQL service. The real-runner job is a placeholder for a self-hosted Judge0 machine and has not run.

## Runbooks

- [`docs/runbooks/development.md`](docs/runbooks/development.md): local setup details and troubleshooting
- [`docs/runbooks/judging-recovery.md`](docs/runbooks/judging-recovery.md): stuck or failed submissions, leases, retries and safe requeueing
