# Self-assessed DOM exercises

The first exercise is `/problems/accessible-accordion` (Workshop FAQ accordion).
Run the normal API/web stack after applying migrations. No worker or Judge0 is
needed for DOM preview or completion. Existing Node exercises still need the
worker and isolated runner.

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev:web
# In another terminal, use API_ORIGIN=http://localhost:5173 and start the API:
pnpm --filter @bekor/api exec tsx --env-file=../../.env src/main.ts
```

Restart the API after changing authored content; it publishes immutable versions
on startup. Do not change an already published id/version. DOM content lives in
`content/dom/`; Node content remains in `content/exercises/`. For a local
development stack, use the database setup in `development.md`.

## Preview hosting and network

The preview client is loaded lazily when opening a DOM workspace. It sends
editable project files to a dedicated cross-origin Sandpack browser compiler.
Code stays out of the API/worker execution path. The browser needs network access
to that compiler host and its package/CDN assets; this feature is not offline.
See `../decisions/dom-preview.md` for the exact host, compiler/framework pins,
licensing, network policy, isolation details and measured compatibility.

Bekor credentials, user ids, practice session ids and completion APIs are never
sent as preview configuration. The iframe runs with scripts and its own origin;
forms, popups, top navigation and privileged device permissions are unavailable.
A separate-window preview is another sandboxed iframe, opened only by the user.
Closing it preserves the editor draft; route/user/session changes dispose it.

The preview has bounded project source and console display, but no hard CPU or
memory quota. Correct a looping draft in the editor and use **Restart preview**
to replace its browsing context. Compilation errors preserve drafts. Reset files
requires confirmation and replaces all files with starters. Hosted dependency
failures need a working connection and another restart.

## Completion and review

Preview rendering never changes completion or scheduling. The learner checks the
requirements and explicitly confirms solved. Free practice **Mark complete**
creates self-assessed history without a card. Scheduled sessions ask for a recall
rating and use the same FSRS service as Node exercises. Cards and drafts are
separate per framework/language; every new review starts from its starter files.
Existing reviews can report unable and choose Again. Revealing a solution or
reporting outside help restricts the rating to Again. Every DOM completion still
requires an explicit solved/unable outcome.

History and review queues label this evidence **Self-assessed**. There is no
accepted verdict, source upload, submission, hidden test, or judging job. Browser
and token clients use the same version/variant/session/completion API; the CLI
commands for downloading the preview setup are planned once the base CLI exists.

## Verification

```sh
pnpm content:validate
pnpm test
pnpm typecheck
# Admin PostgreSQL URL must allow temporary database creation:
TEST_DATABASE_URL=postgresql://... pnpm test:integration
pnpm --filter @bekor/web build
pnpm check:web-bundle
# Against a running real web/API/PostgreSQL stack with registration enabled:
BEKOR_E2E_URL=http://localhost:5173 pnpm exec playwright test tests/e2e/dom.e2e.ts
```

These browser tests check Bekor behavior and trusted authored references; they do
not grade learner code.
