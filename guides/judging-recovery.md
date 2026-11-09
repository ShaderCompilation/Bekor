# Judging recovery runbook

Use this when submissions stay `queued`/`running` or end in `infrastructure_error`. It describes the code as of 2026-10-27 (`packages/core/src/submissions.ts`, `packages/core/src/queue.ts`, `apps/worker/src/{main,processor,repository}.ts`). The database is the source of truth. pg-boss jobs only wake a worker.

## How judging works

1. **Enqueue (API).** In one transaction, the API inserts a `submissions` row (`status = 'queued'`) and a pg-boss job `{ submissionId }` on queue `judge-submission`. The queue has `retryLimit 2`, exponential `retryDelay 2`, and `expireInSeconds 150`.
2. **Claim (worker).** `claim()` locks the row `FOR UPDATE` and skips it unless `status` is `queued`/`running` and no unexpired lease exists. If `worker_attempts >= 3` it marks the submission `infrastructure_error` and stops. Otherwise it sets `status = 'running'`, `lease_owner` (a random UUID per claim), `lease_expires_at = now + 150 s`, and `worker_attempts += 1`. The lease is not renewed.
3. **Per case** (public tests, then private tests for `submit`). Cases that already have a `case_results` row are skipped.
   - If the latest `execution_attempts` row for the case has a `provider_token`, the worker **re-polls that token** instead of dispatching again, so a crash after dispatch does not run the code twice.
   - Otherwise `intent()` marks any leftover `intent` row `uncertain` and inserts a new `intent` row. At most 3 attempts are allowed per case (DB check `attempt_number between 1 and 3`); beyond that the error is non-retryable. The worker then dispatches to Judge0, and `dispatched()` stores the token.
   - It polls with backoff (100 ms doubling to 2 s). `saveCase()` stores the judged case (diagnostics and actual values only for public cases) and marks the attempt `completed`.
   - Every write re-checks the lease (`lock()`). A lost lease raises `LeaseLostError`, and the worker abandons the claim silently.
4. **Budgets.** Each claim gets 120 s. The total is 600 s from the first intent. When the claim budget is exhausted, the error is retryable while total budget remains.
5. **Finish.** `finish()` requires exactly `total_count` contiguous case results, then sets `completed`, the verdict, `public_results`, and (for an accepted `submit`) `problem_progress`.
6. **Failure.** `fail()` sends a retryable error back to `queued` (lease cleared) while `worker_attempts < 3`. Anything else becomes terminal `infrastructure_error` with the diagnostic `Execution infrastructure unavailable.` The worker then rethrows, so pg-boss retries the job.
7. **Recovery loop** (every 30 s, at startup too). This re-sends jobs for up to 100 submissions that are `queued` with `updated_at` older than 60 s, or `running` with an expired lease. Each uses `singletonKey recovery:<id>` for 60 s. This covers lost or expired pg-boss jobs and crashed workers.

Notes:

- Judge0 non-2xx responses other than 429/5xx (e.g. 404 for a token Judge0 no longer knows) are non-retryable, so they end in `infrastructure_error`.
- `infrastructure_error` and `completed` are terminal. The worker never touches them again.

## Diagnose

Use `psql "$DATABASE_URL"`.

```sql
-- Overview of non-terminal and failed work
select status, count(*), min(created_at) as oldest, max(updated_at) as newest_update
from submissions
where status in ('queued', 'running', 'infrastructure_error')
group by status;

-- Stuck candidates (what the recovery loop would pick up) and lease state
select id, user_id, exercise_id, exercise_version, language, mode, status,
       worker_attempts, lease_owner, lease_expires_at, updated_at, created_at
from submissions
where (status = 'queued' and updated_at < now() - interval '60 seconds')
   or (status = 'running' and lease_expires_at < now())
order by created_at
limit 100;

-- Recent infrastructure errors
select id, exercise_id, language, mode, worker_attempts, diagnostic, completed_at
from submissions
where status = 'infrastructure_error'
order by completed_at desc
limit 50;

-- Per-case attempts and results for one submission
select a.case_index, a.attempt_number, a.status, a.provider_token is not null as has_token,
       a.created_at, a.updated_at, r.verdict, r.passed
from execution_attempts a
left join case_results r on r.submission_id = a.submission_id and r.case_index = a.case_index
where a.submission_id = :'id'
order by a.case_index, a.attempt_number;

-- pg-boss job state for the judging queue (pg-boss schema `pgboss`)
select state, count(*), min(created_on) as oldest
from pgboss.job
where name = 'judge-submission'
group by state;
```

Do not select `submissions.files` or `execution_attempts.result` into shared channels. They hold learner source and private-test outcomes.

Typical causes:

| Symptom                                             | Likely cause                                                                                | Check                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Many `queued`, none `running`                       | No worker, or the worker cannot reach PostgreSQL                                            | Worker logs: `Judging worker started: ...` line; `GET /health` on `WORKER_HEALTH_PORT` |
| `running` with expired lease, attempts `dispatched` | Worker crashed mid-case, or Judge0 is slow                                                  | Recovery re-polls the same token. Check Judge0 health (`/about`, workers container)    |
| Rising `infrastructure_error`                       | Judge0 down/rejecting (auth token, 4xx), exercise content changed, attempt budget exhausted | Worker stderr; attempts table (3 attempts on one case = dispatch budget exhausted)     |

## Requeue safely

Fix the underlying cause first and confirm Judge0 accepts a known-good run (e.g. `pnpm test:runner` against it). Otherwise requeued work just fails again.

- **`queued` / expired `running`**: no action needed. The recovery loop picks them up within ~30 s once a healthy worker runs. To hurry it, restart the worker (recovery runs at startup).
- **Never requeue `completed` submissions.** Verdicts are final and may already have updated progress and review state.
- **`infrastructure_error`**: requeue only submissions that failed during the incident window, and rejudge them **from scratch** in one transaction. Partial requeues do not work. The 600 s total budget is measured from the oldest `execution_attempts.created_at`, so any old attempt left behind makes the worker fail the submission again immediately. Leftover attempts can also hit the per-case cap of 3. Deleting the attempts and partial `case_results` re-executes every case on Judge0. That is harmless for learner code (no side effects outside the sandbox), and these submissions have no verdict or progress yet.

```sql
begin;
-- 1. Choose the submissions (adjust the window); review the list before continuing.
create temporary table requeue on commit drop as
select id from submissions
where status = 'infrastructure_error'
  and completed_at between :'incident_start' and :'incident_end';

-- 2. Discard partial judging state so the worker starts with a fresh budget.
delete from case_results r using requeue q where r.submission_id = q.id;
delete from execution_attempts a using requeue q where a.submission_id = q.id;

-- 3. Reset to queued with a fresh worker budget. Backdate updated_at so the recovery loop
--    (queued and updated_at older than 60 s) re-sends a job on its next pass.
update submissions s
set status = 'queued', worker_attempts = 0, completed_at = null, diagnostic = null,
    lease_owner = null, lease_expires_at = null, updated_at = now() - interval '2 minutes'
from requeue q
where s.id = q.id and s.status = 'infrastructure_error';
commit;
```

Afterwards, watch the overview query until the requeued set reaches `completed` or fails again. Repeated failure means the cause is not fixed: stop requeueing and investigate.
