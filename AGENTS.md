# Working on Bekor

Read `docs/IMPLEMENTATION_PLAN.md` before implementing or delegating work. It is the source of truth for scope, architecture, task dependencies, acceptance criteria, and implementation status.

- Follow the user's chosen frontend: React, Vite, TanStack Router, TanStack Query, and Zustand for client state.
- The coordinating agent owns plan updates, shared contracts, dependency changes, and integration. Subagents work on explicitly assigned tasks and file boundaries, and report evidence to the coordinator.
- Before starting a task, record its owner and mark it `IN_PROGRESS` in the plan. Respect dependencies. Do not mark work `DONE` until its acceptance criteria have been verified.
- Update the plan after meaningful progress, integration, verification, scope changes, or blockers, and before ending an implementation turn. Keep the current handoff accurate enough for a fresh agent to resume.
- Report implemented behavior, changed files, checks actually run, and remaining issues. Never represent mocked execution as verification of the real code runner.
- Keep browser and CLI behavior on the same API, exercise version, submission pipeline, and review scheduling rules.
- Execute submitted code only through the isolated runner. Never execute it in the API or application worker process.
- Use small vertical slices and focused tests. Do not add deferred features or infrastructure without a concrete need.

The planning task has created documentation only. Infrastructure setup, application implementation, publishing, and deployment have not happened.
