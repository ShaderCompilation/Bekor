import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/** History, Settings and Sign out live in the account menu. */
async function accountMenu(page: Page, item: "History" | "Settings" | "Sign out") {
  await page.getByRole("button", { name: /account menu/ }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

// Real stack only: the API, worker, runner and database must be running (see the dev runbook).
// Reference solutions come from the authored content, which the test (not the browser) reads.
const exercise = JSON.parse(readFileSync("content/exercises/word-counts.json", "utf8")) as {
  referenceSolutions: { javascript: string; typescript: string };
};

async function replaceCode(page: Page, code: string) {
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible();
  await editor.locator(".view-lines").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  // Paste, like a learner would: typing would trigger Monaco's bracket auto-closing.
  await page.evaluate((text) => navigator.clipboard.writeText(text), code);
  await page.keyboard.press("ControlOrMeta+V");
  await expect(editor.locator(".view-lines")).toContainText(code.split("\n")[0]?.trim() ?? "");
}

async function resultBadge(page: Page) {
  const result = page.locator("section.result").first();
  await expect(result).toHaveAttribute("aria-busy", "false", { timeout: 90_000 });
  return result;
}

test.describe.configure({ mode: "serial" });
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("learn, judge, schedule and review a problem in both languages", async ({ page }) => {
  const email = `e2e-${Date.now()}@example.test`;

  // Sign up (REGISTRATION_ENABLED=true on the dev API).
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("E2E Learner");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/Password/).fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account" }).click();
  // Signed-in home is the dashboard; a new learner has nothing solved yet.
  await expect(page.getByRole("heading", { name: /Welcome back/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /account menu/ })).toBeVisible();
  await expect(page.locator(".progress-total")).toHaveText(/^0 \/ \d+ solved$/);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Problems" })
    .click();
  await expect(page.getByRole("heading", { name: "Problems", level: 1 })).toBeVisible();

  // Catalog filters live in the URL.
  await page.getByRole("searchbox", { name: "Search" }).fill("word");
  await expect(page).toHaveURL(/q=word/);
  await expect(page.getByRole("link", { name: /Word Counts/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Compact Spaces/ })).toHaveCount(0);
  await page.getByRole("link", { name: /Word Counts/ }).click();
  await expect(page.getByRole("heading", { name: "Word Counts", level: 1 })).toBeVisible();

  // JavaScript learning session: starter fails, reference solution is accepted.
  await page.getByLabel("Language").selectOption("javascript");
  await page.getByRole("button", { name: "Start scheduled session" }).click();
  await expect(page.getByRole("heading", { name: "Learning session" })).toBeVisible();
  await expect(page).toHaveURL(/session=/);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  let result = await resultBadge(page);
  await expect(result).toContainText("Wrong answer");
  await expect(result).toContainText("Expected");

  // Ratings stay disabled until an accepted Submit exists in this session.
  await expect(page.getByRole("button", { name: /^Good/ })).toBeDisabled();
  await replaceCode(page, exercise.referenceSolutions.javascript);
  // The shown result belongs to the earlier code, and the page says so.
  await expect(page.getByText("You have edited the code since this was judged")).toBeVisible();
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  result = await resultBadge(page);
  await expect(result).toContainText("Accepted");
  await expect(result).toContainText(/(\d+)\/\1 tests passed/);

  // Reload restores the session, the draft and the latest result.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Learning session" })).toBeVisible();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("wordCounts");
  result = await resultBadge(page);
  await expect(result).toContainText("Accepted");

  await page.getByRole("button", { name: /^Good/ }).click();
  await expect(page.getByRole("heading", { name: "Session complete" })).toBeVisible();
  await expect(page.getByRole("main").getByText(/Next review/)).toBeVisible();

  // TypeScript free practice: a type error is a compilation error, then accepted.
  await page.getByRole("button", { name: "Keep practicing freely" }).click();
  await page.getByLabel("Language").selectOption("typescript");
  await expect(page).toHaveURL(/language=typescript/);
  await replaceCode(
    page,
    "export function wordCounts(words: string[]): Record<string, number> {\n  const n: number = 'x';\n  return {};\n}\n",
  );
  // Ctrl/Cmd+Enter inside the editor runs the public tests.
  await page.keyboard.press("ControlOrMeta+Enter");
  result = await resultBadge(page);
  await expect(result).toContainText("Compilation error");
  await replaceCode(page, exercise.referenceSolutions.typescript);
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  result = await resultBadge(page);
  await expect(result).toContainText("Accepted");
  // Reset is explicit (confirmed) and restores the starter.
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("Count occurrences");
  await expect(page.getByRole("button", { name: "Reset" })).toBeDisabled();

  // Progress comes from the server: the catalog marks the problem solved and filters by it.
  await page.goto("/problems?status=solved");
  const solvedRow = page.locator(".problem-row", { hasText: "Word Counts" });
  await expect(solvedRow).toContainText("Solved");
  await expect(page.locator(".problem-row")).toHaveCount(1);
  await page.goto("/");
  await expect(page.locator(".progress-total")).toHaveText(/^1 \/ \d+ solved$/);
  await expect(page.getByRole("link", { name: "Word Counts" })).toBeVisible();
  await expect(page.getByText(/Current streak/)).toBeVisible();

  // History lists all attempts and opens a detail view with the judged source.
  await accountMenu(page, "History");
  await expect(page.getByRole("heading", { name: "Submission history" })).toBeVisible();
  await expect(page.locator("table.history tbody tr")).toHaveCount(4);
  await page.locator("table.history tbody tr a").first().click();
  await expect(page.getByRole("heading", { name: "Submitted code" })).toBeVisible();

  // Reviews: FSRS schedules the new JS card a short learning step ahead, so it is listed for
  // today. A review starts from the starter code, and a reveal limits the rating to Again.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Reviews" })
    .click();
  const card = page.locator(".review-row", { hasText: "Word Counts" });
  await expect(card).toContainText("JavaScript");
  await card.getByRole("button", { name: "Start review" }).click();
  await expect(page.getByRole("heading", { name: "Review session" })).toBeVisible();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("Count occurrences");
  await page.getByRole("button", { name: "Show hints (recorded)" }).click();
  await expect(page.getByText("Hints (use recorded)")).toBeVisible();

  // Leaving keeps the session unfinished; Reviews offers to resume it.
  await page.getByRole("button", { name: "Leave session" }).click();
  await expect(page.getByText(/You have an unfinished review session/)).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Reviews" })
    .click();
  const unfinished = page
    .locator(".review-row")
    .filter({ has: page.getByRole("button", { name: "Resume" }) });
  await expect(unfinished).toContainText("hint");
  await unfinished.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("heading", { name: "Review session" })).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Reveal solution" }).click();
  await expect(page.getByRole("heading", { name: "Reference solution" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Good/ })).toBeDisabled();
  await page.getByRole("button", { name: /^Again/ }).click();
  await expect(page.getByRole("heading", { name: "Session complete" })).toBeVisible();

  // Sign out clears private state.
  await accountMenu(page, "Sign out");
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await page.goto("/history");
  await expect(page).toHaveURL(/sign-in/);
});

test("narrow screens keep pages within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  for (const path of ["/", "/problems", "/problems/compact-spaces", "/sign-in"]) {
    await page.goto(path);
    await expect(page.locator("main h1")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
  }
});

test("keyboard users can reach the main navigation and content", async ({ page }) => {
  await page.goto("/problems");
  await expect(page.getByRole("heading", { name: "Problems", level: 1 })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Bekor" })).toBeFocused();
});

test("an expired session sends the user back to sign-in", async ({ page, context }) => {
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Expiring Learner");
  await page.getByLabel("Email").fill(`e2e-expire-${Date.now()}@example.test`);
  await page.getByLabel(/Password/).fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("button", { name: /account menu/ })).toBeVisible();
  // The server no longer recognises the browser; the next private request gets 401.
  await context.clearCookies();
  const checks: string[] = [];
  page.on("request", (request) => {
    if (/\/(auth|api)\//.test(request.url())) checks.push(request.url());
  });
  await accountMenu(page, "History");
  await expect(page).toHaveURL(/sign-in/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  // One rejected request is enough; no retry or refetch loop against the server.
  await page.waitForTimeout(1000);
  expect(checks.length, checks.join("\n")).toBeLessThanOrEqual(3);
});

test("shell: legacy links, theme, search palette and resizable panes persist", async ({ page }) => {
  // Old catalog links at "/" keep working.
  await page.goto("/?q=word");
  await expect(page).toHaveURL(/\/problems\?q=word/);
  await expect(page.getByRole("link", { name: /Word Counts/ })).toBeVisible();

  // An explicit theme survives a reload.
  const theme = page.getByRole("button", { name: /^Theme:/ });
  await theme.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await theme.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // Ctrl/Cmd+K searches problems and opens one with the keyboard.
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("combobox", { name: "Search problems and pages" });
  await expect(palette).toBeFocused();
  await palette.fill("compact spaces");
  await expect(page.getByRole("option", { name: /Compact Spaces/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Compact Spaces", level: 1 })).toBeVisible();

  // "?" opens the shortcut help; Escape closes it.
  await page.locator("body").press("?");
  await expect(page.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Keyboard shortcuts" })).toBeHidden();

  // The statement/work splitter is keyboard operable and remembered.
  const splitter = page.getByRole("separator", { name: "Resize problem description" });
  await expect(splitter).toHaveAttribute("aria-valuenow", "40");
  await splitter.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(splitter).toHaveAttribute("aria-valuenow", "44");
  await page.reload();
  await expect(page.getByRole("separator", { name: "Resize problem description" })).toHaveAttribute(
    "aria-valuenow",
    "44",
  );

  // Next walks the catalog; the breadcrumb returns to it.
  await page.getByRole("button", { name: /^Next/ }).click();
  await expect(page.getByRole("heading", { name: "Compact Spaces", level: 1 })).toBeHidden();
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link").click();
  await expect(page.getByRole("heading", { name: "Problems", level: 1 })).toBeVisible();
});
