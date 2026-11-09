# Decision: where the Judge0 runner runs

Status: **proposed** for production (2026-10-27). Real execution is unverified until one of these options passes `pnpm test:runner`.

**Interim, accepted 2026-10-27:** for personal development use, option **F** below (a Podman container per execution) replaces Judge0. The project prioritised implementation speed over isolation, JS/TS only, and will revisit before production.

## Context

- Bekor executes learner JavaScript/TypeScript only in Judge0. Never in the API or worker process.
- Judge0 1.13.1 (latest release) uses isolate 1.8.1, which needs **cgroup v1** and **privileged** containers. Upstream documents booting with `systemd.unified_cgroup_hierarchy=0`.
- The development host is Fedora with cgroup v2 only and **rootless** Podman. Measured results: the image cannot even be unpacked into the default rootless store (UID 197609 > 65536 subordinate IDs). In a workaround store, `isolate --cg --init` fails because `/sys/fs/cgroup/memory` does not exist.
- Changing the host's kernel boot, cgroups, or subordinate IDs is out of scope for this project's agents.

## Options

| Option                                                                                                                                                                        | Works with Judge0 1.13.1       | Isolation from app/secrets                                                                                                                   | Cost / effort                                                                                            | Notes                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A. **Dedicated VM, rootful Docker/Podman, cgroup v1 boot** (e.g. Ubuntu 22.04 with `systemd.unified_cgroup_hierarchy=0`), running the `runner` profile's Judge0 services only | Yes (upstream-supported setup) | Strong: separate kernel; only the worker reaches it over a private network                                                                   | One small VM; local option: a libvirt/QEMU VM on the dev machine (needs the user's consent to create it) | **Recommended.** Same artifact for CI (self-hosted runner) and private beta     |
| B. Change the dev host to cgroup v1 + rootful engine                                                                                                                          | Yes                            | Weak: privileged containers on the developer machine                                                                                         | Host reboot and config change                                                                            | Rejected: host change, and Fedora is moving away from cgroup v1                 |
| C. Judge0 fork / isolate 2.x with cgroup v2                                                                                                                                   | Possibly                       | Same as A                                                                                                                                    | Maintain a fork of a GPL project; re-verify all limits                                                   | Revisit only if cgroup v1 hosts become unavailable                              |
| D. Different sandbox (e.g. go-judge, which supports cgroup v2 via systemd scopes)                                                                                             | n/a                            | Comparable                                                                                                                                   | New adapter, contracts and verification                                                                  | Out of current scope (user selected Judge0)                                     |
| F. **Dev-only: rootless Podman container per execution** (`RUNNER=podman`, `packages/runner/src/podman.ts`, image `infra/runner`)                                             | n/a                            | Moderate: no network, read-only rootfs, no host files or worker env, memory/CPU/pids limits; **shared host kernel**, rootless user namespace | Done; passes `pnpm test:runner` on the dev host                                                          | **Accepted for personal use only.** Refused when `NODE_ENV=production`          |
| E. Public/hosted Judge0 API                                                                                                                                                   | n/a                            | Learner code and test inputs leave our control                                                                                               | —                                                                                                        | Rejected: the plan forbids public endpoints for the suite and for private tests |

## Recommendation

Adopt **A**:

1. Create a dedicated Linux VM (Ubuntu 22.04 LTS or Debian 11), boot with `systemd.unified_cgroup_hierarchy=0`, and install a rootful Docker or Podman engine with a compose provider.
2. Build `infra/compose/judge0/Dockerfile` (Judge0 1.13.1 by digest + Node 24.22.1 + TypeScript 7.0.2). Run `judge0-server`, `judge0-workers`, `judge0-postgres` and `judge0-redis` from the `runner` profile.
3. Expose port 2358 only on a private interface reachable by the worker (and the CI self-hosted runner). Set `JUDGE0_AUTH_TOKEN`. Keep `ALLOW_ENABLE_NETWORK=false`.
4. Register the VM (or a sibling VM) as the `self-hosted, linux, judge0` GitHub runner for the `real-runner` CI job. Keep no application secrets on it.
5. Run `JUDGE0_URL=… pnpm test:runner`, then record versions, results, timings and memory.

Until then, application work continues with the labelled fake adapter. Real Judge0 execution stays unverified.

## Result forgery defenses (2026-10-27)

Learner code runs in the same Node process as the harness, so the worker must not trust any line on stdout. The harness now:

- reads `{nonce, args}` from stdin, closes fd 0 and removes `stdin.txt` before importing the solution;
- echoes the nonce in the result envelope; the worker rejects envelopes whose nonce does not equal the execution-attempt ID (random, persisted, never exposed through the API);
- replaces `process.exit` / `process.reallyExit` so learner code can only exit non-zero, and exits 0 itself only after writing the result.

Residual risk: same-process code could in principle scrape the nonce from its own memory (for example via `/proc/self/mem`). Removing that requires running the solution in a separate process from the reporting harness; revisit when the real runner is available. `packages/runner/tests/harness.test.ts` runs the generated harness locally on trusted forgery fixtures; that is not sandbox verification.
