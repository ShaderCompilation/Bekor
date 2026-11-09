# Development runbook

Local development only. Nothing here deploys anything.

## Layout

| Path              | Purpose                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `apps/api`        | Hono HTTP API. `src/env.ts` validates its environment                                        |
| `apps/worker`     | pg-boss judging worker. `src/env.ts`, `src/processor.ts`, `src/repository.ts`                |
| `packages/core`   | Domain services, plus the shared queue (`createQueue`, `JUDGE_QUEUE`) used by API and worker |
| `packages/db`     | Drizzle schema and migrations (`pnpm db:migrate`)                                            |
| `packages/runner` | Judge0 adapter, sandbox harness, result protocol                                             |
| `infra/compose`   | Development Compose stack, dev image, Judge0 runner image/config                             |
| `apps/web`        | React SPA (Vite). Dev server proxies `/api`, `/auth`, `/health` to the API                   |

## Environment

Copy `.env.example` to `.env`. The API needs `DATABASE_URL`, `API_ORIGIN`, `BETTER_AUTH_SECRET` (32+ chars), and optionally `PORT` and `REGISTRATION_ENABLED`. With `NODE_ENV=production`, `API_ORIGIN` must be `https://`. The worker needs `DATABASE_URL` and `JUDGE0_URL` (http(s), no credentials, query or fragment), and optionally `JUDGE0_AUTH_TOKEN` and `WORKER_HEALTH_PORT`/`WORKER_HEALTH_HOST`.

Empty values count as unset. On failure the process exits with one message listing every problem, by variable name only.

Neither `pnpm` nor `tsx` loads `.env` automatically. Pass `--env-file` (see README) or export the variables.

## Compose stack

`infra/compose/compose.yaml`:

| Service                                                              | Profile            | Notes                                                                                                                            |
| -------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`                                                           | default            | `postgres:17.11-alpine`, named volume `postgres-data`, `127.0.0.1:${POSTGRES_PORT:-55432}`                                       |
| `migrate`                                                            | default            | One-shot `pnpm db:migrate`; `api`/`worker` wait for it to complete                                                               |
| `api`                                                                | default            | From source via `infra/compose/Dockerfile` (Node 24.22.1, pnpm 12.14.0), `127.0.0.1:${API_PORT:-3000}`, healthcheck on `/health` |
| `worker`                                                             | `worker`, `runner` | Health on `127.0.0.1:3001/health` inside the container; joins `app` and `runner` networks                                        |
| `judge0-server`, `judge0-workers`, `judge0-postgres`, `judge0-redis` | `runner`           | Judge0 1.13.1 + Bekor runtime, privileged, internal network only                                                                 |

The dev image is built from the repository root with `infra/compose/Dockerfile.dockerignore`, which excludes `node_modules`, `.git` and `.env*`. It runs `pnpm install --frozen-lockfile` inside the image, so rebuild (`--build`) after changing dependencies or source. The image runs source with `tsx` and does not bind-mount the checkout.

Tear down with `podman compose -f infra/compose/compose.yaml down`. Add `-v` to delete the database volume.

### Verified on the Fedora dev host (2026-10-27)

No compose provider is installed (`podman compose` reports no provider; `podman-compose` and `docker-compose` are absent), so the file has not been run through `compose config`/`up`. Instead:

- `compose.yaml` was parsed and checked structurally: service/network/volume references, profile scoping of `depends_on`, loopback-only ports, pinned images, API not on the runner network, and the runner network internal.
- The equivalent of the default profile was run by hand with `podman run`: the dev image was built, `postgres:17.11-alpine` became healthy, `pnpm db:migrate` succeeded, and the API answered `{"status":"ok"}` on `/health` (healthcheck command passed). The API with no `BETTER_AUTH_SECRET`, and the worker with no `DATABASE_URL`/`JUDGE0_URL`, exited with clear errors. The worker with an unreachable runner started, logged `runnerToken=set` without the token, passed its healthcheck, and stopped cleanly on SIGTERM.

## Web app

Run `pnpm dev:web` with the API's `API_ORIGIN=http://localhost:5173`. The browser only talks to the Vite origin, so cookies and the API's Origin check line up as they will in a same-origin production deployment. Drafts and UI preferences live in `localStorage` (`bekor.drafts`, `bekor.preferences`); sessions are HttpOnly cookies, never stored by the app.

## Troubleshooting

- **Web: "A matching Origin header is required" (403) or sign-in loops**: `API_ORIGIN` does not match the origin in the browser address bar.
- **Web: "Too many attempts"**: Better Auth rate limit. In development every request counts as `127.0.0.1`; wait a minute. In production the API must receive a trusted `X-Forwarded-For`, or all clients share one bucket.

- **`Invalid API environment` / `Invalid worker environment`**: fix each listed variable.
- **Port 55432 already in use**: set `POSTGRES_PORT` in `.env` and update `DATABASE_URL`.
- **Integration tests skipped**: `TEST_DATABASE_URL` is unset. It must be an admin URL whose role can `CREATE DATABASE`.
- **Submissions stay `queued`**: no worker is running, or the worker cannot reach Judge0. See [judging-recovery.md](judging-recovery.md).
- **Judge0 image pull fails under rootless Podman** with `potentially insufficient UIDs or GIDs ... 197609`: the image contains files owned by UID 197609, beyond the default 65536 subordinate IDs. Judge0 cannot sandbox under rootless Podman anyway; use a rootful engine on a dedicated VM ([decision](../decisions/runner.md)).
