# Working on Bekor

Maintainers keep a private implementation plan at `docs/IMPLEMENTATION_PLAN.md` (the `docs/` folder is gitignored). If it exists in your checkout, read it before implementing or delegating work: it is the source of truth for scope, architecture, task dependencies, acceptance criteria and status. Otherwise start from `README.md` and `guides/`.

- Follow the chosen frontend: React, Vite, TanStack Router, TanStack Query, and Zustand for client state.
- The coordinating agent owns plan updates, shared contracts, dependency changes, and integration. Subagents work on explicitly assigned tasks and file boundaries, and report evidence to the coordinator.
- When the plan exists: before starting a task, record its owner and mark it `IN_PROGRESS`. Respect dependencies. Do not mark work `DONE` until its acceptance criteria have been verified. Update the plan after meaningful progress, integration, verification, scope changes, or blockers, and before ending an implementation turn.
- Report implemented behavior, changed files, checks actually run, and remaining issues. Never represent mocked execution as verification of the real code runner.
- Keep browser and CLI behavior on the same API, exercise version, submission pipeline, and review scheduling rules.
- Execute submitted code only through the isolated runner. Never execute it in the API or application worker process.
- Use small vertical slices and focused tests. Do not add deferred features or infrastructure without a concrete need.
- Exercises must be original: write statements, tests and solutions from scratch, and never copy third-party exercise text or solution code.

The backend (API, worker, runner adapter, scheduling, persistence) and the web app are implemented and verified against real PostgreSQL with the development Podman runner. Real Judge0 execution, the CLI, publishing and deployment have not happened.
