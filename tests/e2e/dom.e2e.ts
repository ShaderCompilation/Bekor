import { readFileSync } from "node:fs";
import type { PracticeSession, ReviewQueue } from "@bekor/contracts";
import { expect, type Frame, type Page, test } from "@playwright/test";

/** History, Settings and Sign out live in the account menu. */
async function accountMenu(page: Page, item: "History" | "Settings" | "Sign out") {
  await page.getByRole("button", { name: /account menu/ }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

// Real web/API/PostgreSQL and real browser compilers. No runner, grading fixture,
// API interception or mocked preview is used for this self-assessed exercise.
const authored = JSON.parse(readFileSync("content/dom/accessible-accordion.json", "utf8")) as {
  public: {
    checklist: string[];
    variants: { id: string; framework: string; entry: string; files: Record<string, string> }[];
  };
  referenceSolutions: Record<string, Record<string, string>>;
};
const variants = authored.public.variants;

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

async function signUp(page: Page) {
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("DOM Learner");
  await page.getByLabel("Email").fill(`dom-${Date.now()}-${Math.random()}@example.test`);
  await page.getByLabel(/Password/).fill("correct horse battery staple");
  for (let attempt = 0; attempt < 2; attempt++) {
    const responseReady = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/auth/sign-up/email" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create account" }).click();
    const response = await responseReady;
    if (response.status() !== 429) {
      expect(response.status(), await response.text()).toBe(200);
      break;
    }
    // Real auth allows three registrations per minute. Respect its Retry-After
    // when this four-journey suite reaches the fourth registration.
    let remaining = (Number(response.headers()["retry-after"]) || 60) * 1000 + 1000;
    while (remaining > 0) {
      const wait = Math.min(remaining, 30_000);
      await page.waitForTimeout(wait);
      remaining -= wait;
    }
  }
  await expect(page.getByRole("button", { name: /account menu/ })).toBeVisible();
  await page.goto("/problems/accessible-accordion");
  await expect(
    page.getByRole("heading", { name: "Workshop FAQ accordion", level: 1 }),
  ).toBeVisible();
}

async function replaceCode(page: Page, path: string, source: string) {
  await page.getByRole("tab", { name: path, exact: true }).click();
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible();
  await editor.locator(".view-lines").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await page.evaluate((text) => navigator.clipboard.writeText(text), source);
  await page.keyboard.press("ControlOrMeta+V");
  // Monaco virtualizes lines. Verify the actual persisted editor change rather
  // than assuming any particular source line is currently rendered on screen.
  const framework = (await page.getByLabel("Framework").inputValue()).split("-")[0]!;
  await expect
    .poll(() =>
      page.evaluate(
        ({ path, source, framework }) => {
          const stored = JSON.parse(localStorage.getItem("bekor.drafts") ?? "null") as {
            state?: { drafts?: Record<string, { source: string }> };
          } | null;
          const sessionId = new URL(location.href).searchParams.get("session") ?? "free";
          return Object.entries(stored?.state?.drafts ?? {}).some(([key, draft]) => {
            if (!key.endsWith(`|${sessionId}|${framework}`)) return false;
            try {
              return JSON.parse(draft.source)[path] === source;
            } catch {
              return false;
            }
          });
        },
        { path, source, framework },
      ),
    )
    .toBe(true);
  await page.keyboard.press("ControlOrMeta+Home");
}

async function installReference(page: Page, variant: (typeof variants)[number]) {
  const reference = authored.referenceSolutions[variant.id]!;
  for (const [path, source] of Object.entries(reference))
    if (source !== variant.files[path]) await replaceCode(page, path, source);
  // Replace the browsing context so checks cannot interact with the previous
  // starter while the debounced compiler update is still pending.
  await page.getByRole("button", { name: "Restart preview", exact: true }).click();
}

async function confirmChecklist(page: Page) {
  const assessment = page.getByRole("region", { name: "Self-assessment", exact: true });
  for (const item of authored.public.checklist)
    await assessment.getByLabel(item, { exact: true }).check();
  await assessment.getByLabel("I confirm that my solution satisfies every requirement.").check();
}

async function getApi<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (path) => {
    const response = await fetch(`/api/v1${path}`);
    if (!response.ok) throw new Error(`API ${response.status}`);
    return response.json();
  }, path) as Promise<T>;
}

async function previewFrame(page: Page): Promise<Frame> {
  let found: Frame | undefined;
  await expect
    .poll(
      async () => {
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          try {
            if (
              (await frame
                .getByRole("button", { name: "What should I bring?", exact: true })
                .count()) === 1
            ) {
              found = frame;
              return true;
            }
          } catch {
            // A compiler update may replace the previous iframe while it is inspected.
          }
        }
        return false;
      },
      { timeout: 90_000, message: "actual framework preview renders the accordion reference" },
    )
    .toBe(true);
  if (!found) throw new Error("Preview frame unavailable");
  return found;
}

async function checkPreview(page: Page) {
  const frame = await previewFrame(page);
  const first = frame.getByRole("button", { name: "What should I bring?", exact: true });
  const second = frame.getByRole("button", { name: "When can I arrive?", exact: true });
  const third = frame.getByRole("button", { name: "Is the studio step-free?", exact: true });
  for (const button of [first, second, third])
    await expect(button).toHaveAttribute("aria-expanded", "false");
  await first.click();
  await second.click();
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await expect(second).toHaveAttribute("aria-expanded", "true");
  await first.click();
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await expect(second).toHaveAttribute("aria-expanded", "true");
  await third.focus();
  await page.keyboard.press("Enter");
  await expect(third).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Space");
  await expect(third).toHaveAttribute("aria-expanded", "false");
  expect(await frame.locator('[role="region"]:not([hidden])').count()).toBe(1);
}

test("all four frameworks render real references, keep separate drafts and require explicit completion", async ({
  page,
}) => {
  test.setTimeout(360_000);
  await signUp(page);
  await expect(page.getByRole("button", { name: "Mark complete", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Framework").locator("option")).toHaveCount(4);
  for (const variant of variants) {
    await page.getByLabel("Framework").selectOption(variant.id);
    await expect(page).toHaveURL(new RegExp(`framework=${variant.framework}`));
    await installReference(page, variant);
    await checkPreview(page);
    const iframe = page.getByTitle("DOM exercise preview", { exact: true });
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
    const source = await iframe.getAttribute("src");
    expect(source).toBeTruthy();
    expect(new URL(source!).origin).toBe("https://2-19-8-sandpack.codesandbox.io");
    await expect(page.getByRole("button", { name: "Mark complete", exact: true })).toBeDisabled();
  }
  // Compilation/rendering and switching variants never persist a completion.
  expect(
    (await getApi<{ items: PracticeSession[] }>(page, "/me/self-assessments")).items,
  ).toHaveLength(0);
  expect((await getApi<ReviewQueue>(page, "/me/reviews")).due).toHaveLength(0);
  await page.getByLabel("Framework").selectOption("vanilla-javascript");
  await page.getByRole("tab", { name: "index.js", exact: true }).click();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("addEventListener");
  await page.reload();
  await expect(page.getByLabel("Framework")).toHaveValue("vanilla-javascript");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("addEventListener");
  await confirmChecklist(page);
  await page.getByRole("button", { name: "Mark complete", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Self-assessed complete", exact: true }),
  ).toBeVisible();
  const history = await getApi<{ items: PracticeSession[] }>(page, "/me/self-assessments");
  expect(history.items).toHaveLength(1);
  expect(history.items[0]).toMatchObject({
    framework: "vanilla",
    kind: "practice",
    rating: null,
    assessment: { outcome: "solved", provenance: "self" },
  });
  expect((await getApi<ReviewQueue>(page, "/me/reviews")).due).toHaveLength(0);
  expect((await getApi<{ items: unknown[] }>(page, "/me/submissions")).items).toHaveLength(0);
  await accountMenu(page, "History");
  await expect(page.getByRole("heading", { name: "Self-assessed DOM practice" })).toBeVisible();
  await expect(
    page.getByText(/vanilla · JavaScript · v1.0.0 · Self-assessed solved · unscheduled/),
  ).toBeVisible();
  await expect(page.getByText("No submissions yet")).toBeVisible();
});

test("manual learning, resume, unable, reveal and independent framework cards persist through the real API", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signUp(page);
  const vanilla = variants.find((variant) => variant.framework === "vanilla")!;
  await installReference(page, vanilla);
  await page.getByRole("button", { name: "Start scheduled session" }).click();
  await expect(
    page.getByRole("heading", { name: "learning session · vanilla", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Framework")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Good", exact: true })).toBeDisabled();
  const learningId = new URL(page.url()).searchParams.get("session");
  expect(learningId).toBeTruthy();
  await confirmChecklist(page);
  await page.getByRole("button", { name: "Good", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Self-assessed completion", exact: true }),
  ).toBeVisible();
  const firstCard = (await getApi<ReviewQueue>(page, "/me/reviews")).due[0]!;
  expect(firstCard.framework).toBe("vanilla");
  // The same completion can be retried safely; another rating conflicts.
  const retries = await page.evaluate(async (id) => {
    const statuses: number[] = [];
    for (const rating of ["good", "easy"])
      statuses.push(
        (
          await fetch(`/api/v1/practice-sessions/${id}/complete`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ rating, selfAssessment: "solved" }),
          })
        ).status,
      );
    return statuses;
  }, learningId);
  expect(retries).toEqual([200, 409]);
  await page.getByRole("link", { name: "Reviews", exact: true }).first().click();
  const vanillaRow = page.locator(".review-row", { hasText: "vanilla" });
  await expect(vanillaRow).toContainText("Self-assessed");
  await vanillaRow.getByRole("button", { name: "Start review" }).click();
  await expect(
    page.getByRole("heading", { name: "review session · vanilla", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("TODO");
  await page.getByRole("button", { name: "Show hints", exact: true }).click();
  await expect(page.getByText("Hint use recorded.")).toBeVisible();
  const reviewId = new URL(page.url()).searchParams.get("session");
  await page.getByRole("link", { name: "Reviews", exact: true }).first().click();
  const unfinished = page
    .locator(".review-row")
    .filter({ has: page.getByRole("button", { name: "Resume", exact: true }) });
  await expect(unfinished).toContainText("hint");
  await unfinished.getByRole("button", { name: "Resume", exact: true }).click();
  expect(new URL(page.url()).searchParams.get("session")).toBe(reviewId);
  await page.getByLabel("I attempted it but was unable to complete it.").check();
  await expect(page.getByRole("button", { name: "Good", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Again", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Self-assessed completion", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Reviews", exact: true }).first().click();
  await page
    .locator(".review-row", { hasText: "vanilla" })
    .getByRole("button", { name: "Start review" })
    .click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Reveal solution", exact: true }).click();
  await expect(page.getByText("Revealed solution", { exact: true })).toBeVisible();
  await page.getByLabel("I attempted it but was unable to complete it.").check();
  await expect(page.getByRole("button", { name: "Good", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Again", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Self-assessed completion", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue practicing", exact: true }).click();
  await page.getByLabel("Framework").selectOption("react-javascript");
  await page.getByRole("button", { name: "Start scheduled session" }).click();
  await confirmChecklist(page);
  await page.getByRole("button", { name: "Good", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Self-assessed completion", exact: true }),
  ).toBeVisible();
  const queue = await getApi<ReviewQueue>(page, "/me/reviews");
  expect(queue.due.map((card) => card.framework).sort()).toEqual(["react", "vanilla"]);
  expect(queue.due.find((card) => card.framework === "vanilla")?.id).toBe(firstCard.id);
  expect(queue.unfinished).toHaveLength(0);
  const history = (await getApi<{ items: PracticeSession[] }>(page, "/me/self-assessments")).items;
  expect(history).toHaveLength(4);
  expect(history.filter((session) => session.framework === "vanilla")).toHaveLength(3);
  expect(
    history.some(
      (session) => session.assessment?.outcome === "unable" && session.rating === "again",
    ),
  ).toBe(true);
  expect(history.some((session) => session.solutionRevealed && session.rating === "again")).toBe(
    true,
  );
  expect((await getApi<{ items: unknown[] }>(page, "/me/submissions")).items).toHaveLength(0);
  // The additive detail union still selects the established Node workspace.
  // No submission is executed: the DOM verification stack has no worker.
  await page.goto("/problems/word-counts");
  await expect(page.getByRole("heading", { name: "Word Counts", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Language")).toHaveValue("javascript");
  await expect(page.getByText("solution.js", { exact: true })).toBeVisible();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("wordCounts");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit", exact: true })).toBeVisible();
  await page.getByLabel("Language").selectOption("typescript");
  await expect(page.getByText("solution.ts", { exact: true })).toBeVisible();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("words: string[]");
  await expect(page.getByRole("region", { name: "Live DOM preview", exact: true })).toHaveCount(0);
});

test("separate preview synchronizes, closes cleanly and preserves drafts through compiler recovery", async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await signUp(page);
  const vanilla = variants.find((variant) => variant.framework === "vanilla")!;
  await installReference(page, vanilla);
  await checkPreview(page);
  // Simulated browser policy only: API requests and compiler execution remain real.
  await page.evaluate(() => {
    const target = window as Window & { __bekorOriginalOpen?: typeof window.open };
    target.__bekorOriginalOpen = window.open;
    window.open = () => null;
  });
  try {
    await page
      .getByRole("button", { name: "Open preview in separate window", exact: true })
      .click();
    await expect(
      page.getByText("Popup blocked. Allow popups for Bekor, then try again.", { exact: true }),
    ).toBeVisible();
  } finally {
    await page.evaluate(() => {
      const target = window as Window & { __bekorOriginalOpen?: typeof window.open };
      if (target.__bekorOriginalOpen) window.open = target.__bekorOriginalOpen;
      delete target.__bekorOriginalOpen;
    });
  }
  const popupReady = context.waitForEvent("page");
  await page.getByRole("button", { name: "Open preview in separate window", exact: true }).click();
  const popup = await popupReady;
  await expect(popup).toHaveTitle("Bekor DOM preview");
  await checkPreview(popup);
  const updated = authored.referenceSolutions[vanilla.id]!["index.js"]!.replace(
    "Workshop questions",
    "Updated workshop questions",
  );
  const updateStarted = Date.now();
  await replaceCode(page, "index.js", updated);
  await expect(
    (await previewFrame(page)).getByRole("heading", {
      name: "Updated workshop questions",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    (await previewFrame(popup)).getByRole("heading", {
      name: "Updated workshop questions",
      exact: true,
    }),
  ).toBeVisible();
  const updateMs = Date.now() - updateStarted;
  console.info(`DOM Vanilla editor action to embedded and popup render: ${updateMs} ms`);
  await test.info().attach("dom-preview-update-latency", {
    body: JSON.stringify({
      framework: "vanilla",
      updateMs,
      includes: "Monaco paste, 400ms debounce, browser compile, embedded and popup render",
    }),
    contentType: "application/json",
  });
  await popup.close();
  await expect(
    page.getByText("Separate preview closed. Your editor draft is kept.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText(
    "Updated workshop questions",
  );
  await replaceCode(page, "index.js", "const broken = ; // saved invalid draft");
  const preview = page.getByRole("region", { name: "Live DOM preview", exact: true });
  await expect(preview).toContainText(/Preview error|Compilation failed/);
  await page.reload();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("saved invalid draft");
  await installReference(page, vanilla);
  await checkPreview(page);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Reset files", exact: true }).click();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("TODO");
  expect(
    (await getApi<{ items: PracticeSession[] }>(page, "/me/self-assessments")).items,
  ).toHaveLength(0);
  expect((await getApi<ReviewQueue>(page, "/me/reviews")).due).toHaveLength(0);
  await page.screenshot({ path: "/tmp/bekor-dom-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/bekor-dom-mobile.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
});

test("runtime diagnostics stay bounded and restart recovers an infinite browser preview loop", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signUp(page);
  const vanilla = variants.find((variant) => variant.framework === "vanilla")!;
  await installReference(page, vanilla);
  await checkPreview(page);
  await replaceCode(page, "index.js", 'throw new Error("DOM_RUNTIME_VERIFICATION");');
  const preview = page.getByRole("region", { name: "Live DOM preview", exact: true });
  await preview.getByText(/Preview console and diagnostics/).click();
  await expect(preview.getByLabel("Preview console", { exact: true })).toContainText(
    "DOM_RUNTIME_VERIFICATION",
  );
  await replaceCode(
    page,
    "index.js",
    'for (let index = 0; index < 200; index++) console.log("DOM_BOUNDED_CONSOLE", index);',
  );
  await expect(preview.getByLabel("Preview console", { exact: true })).toContainText(
    "DOM_BOUNDED_CONSOLE",
  );
  const consoleSummary = preview.getByText(/Preview console and diagnostics/);
  const displayedCount = Number((await consoleSummary.textContent())!.match(/\((\d+)\/50\)/)![1]);
  expect(displayedCount).toBeGreaterThan(0);
  expect(displayedCount).toBeLessThanOrEqual(50);
  expect(
    (await preview.getByLabel("Preview console", { exact: true }).textContent())!.split("\n")
      .length,
  ).toBeLessThanOrEqual(50);
  await replaceCode(
    page,
    "index.js",
    'setTimeout(() => { console.log("DOM_LOOP_STARTED"); while (true) {} }, 1100);',
  );
  await expect(preview.getByLabel("Preview console", { exact: true })).toContainText(
    "DOM_LOOP_STARTED",
  );
  // The authored looping fixture runs only in the isolated preview frame. Editing
  // the parent still works; explicit restart replaces the unresponsive context.
  await replaceCode(page, "index.js", authored.referenceSolutions[vanilla.id]!["index.js"]!);
  await expect(page.getByRole("button", { name: "Restart preview", exact: true })).toBeEnabled({
    timeout: 10_000,
  });
  await page
    .getByRole("button", { name: "Restart preview", exact: true })
    .click({ timeout: 10_000 });
  await checkPreview(page);
  expect(
    (await getApi<{ items: PracticeSession[] }>(page, "/me/self-assessments")).items,
  ).toHaveLength(0);
});

test("anonymous DOM URLs with a session show sign-in instead of an indefinite loader", async ({
  page,
}) => {
  await page.goto(
    "/problems/accessible-accordion?framework=vue&language=javascript&session=11111111-1111-4111-8111-111111111111",
  );
  await expect(
    page.getByRole("heading", { name: "Workshop FAQ accordion", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByText("Sign in to edit, preview and record your self-assessment.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "DOM workspace", exact: true })).toHaveCount(0);
});
