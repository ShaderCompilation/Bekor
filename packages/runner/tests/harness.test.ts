// Runs the GENERATED harness locally with Node against trusted, authored fixtures (including
// forgery attempts) to check the result protocol. This is NOT sandbox or Judge0 verification and
// never executes learner submissions.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@bekor/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { makeHarness } from "../src/harness.js";
import { judgeCase, parseResult, RESULT_PREFIX } from "../src/protocol.js";

const nonce = "attempt-0f8e2c4a-6b1d-4e57-9a3c";
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function run(source: string, args: JsonValue[] = [2, 3]) {
  const dir = mkdtempSync(join(tmpdir(), "bekor-harness-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  writeFileSync(join(dir, "solution.js"), source);
  writeFileSync(join(dir, "harness.mjs"), makeHarness("add", 8192));
  const stdin = JSON.stringify({ nonce, args });
  writeFileSync(join(dir, "stdin.txt"), stdin);
  const result = spawnSync(process.execPath, ["harness.mjs"], {
    cwd: dir,
    input: stdin,
    encoding: "utf8",
    timeout: 10_000,
  });
  const parsed = parseResult(result.stdout, 8192, nonce);
  return {
    dir,
    status: result.status,
    stderr: result.stderr,
    // Judge0 reports non-zero exits as runtime errors before the stdout envelope is considered.
    verdict: result.status === 0 ? judgeCase(parsed, 5, true).verdict : ("runtime_error" as const),
  };
}
const forged = (value: object) =>
  JSON.stringify(`${RESULT_PREFIX}${JSON.stringify({ version: 1, ...value })}\n`);

describe("generated harness protocol (local trusted fixtures, not sandbox verification)", () => {
  it("accepts a correct function, keeps debug output on stderr and removes the stdin file", () => {
    const result = run("export function add(a, b) { console.log('dbg', a); return a + b; }");
    expect(result).toMatchObject({ status: 0, verdict: "accepted" });
    // Formatted like Node's console.log: strings unquoted, other values inspected.
    expect(result.stderr).toContain("dbg 2");
    expect(existsSync(join(result.dir, "stdin.txt"))).toBe(false);
  });
  it("reports wrong answers and thrown errors", () => {
    expect(run("export function add(a, b) { return a - b; }").verdict).toBe("wrong_answer");
    const thrown = run("export function add() { throw new Error('boom'); }");
    expect(thrown).toMatchObject({ status: 1, verdict: "runtime_error" });
    expect(thrown.stderr).toContain("boom");
  });
  it.each([
    [
      "forged without nonce, then exit(0)",
      `process.stdout.write(${forged({ actual: 5 })}); process.exit(0);`,
    ],
    [
      "forged without nonce, then reallyExit(0)",
      `process.stdout.write(${forged({ actual: 5 })}); process.reallyExit(0);`,
    ],
    [
      "guessed nonce, then exit(0)",
      `process.stdout.write(${forged({ nonce: "guess-guess-guess-1", actual: 5 })}); process.exit(0);`,
    ],
    [
      "forged line plus a wrong return",
      `process.stdout.write(${forged({ actual: 5 })}); return 4;`,
    ],
    [
      "exitCode tampering after a forged line",
      `process.stdout.write(${forged({ actual: 5 })}); Object.defineProperty(process, 'exitCode', { set() {}, get() { return 0; } }); throw new Error('x');`,
    ],
  ])("never accepts %s", (_name, body) => {
    expect(run(`export function add() { ${body} }`).verdict).not.toBe("accepted");
  });
  it("prevents learner code from re-reading the nonce from stdin", () => {
    const result = run(
      "import { readFileSync } from 'node:fs'; export function add() { return readFileSync(0, 'utf8').length; }",
    );
    expect(result.verdict).toBe("runtime_error");
  });
  it("rejects unsupported results instead of coercing them", () => {
    expect(run("export function add() { return 1.5; }").verdict).toBe("runtime_error");
    expect(run("export function add() { return undefined; }").verdict).toBe("runtime_error");
  });
});
