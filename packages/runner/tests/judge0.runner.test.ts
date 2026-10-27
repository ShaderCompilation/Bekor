// REAL Judge0 suite. Runs only when JUDGE0_URL points at a private, isolated Judge0 deployment built
// from infra/compose/judge0 (Node 24.22.1 + TypeScript 7.0.2 under /usr/local/bekor). Never point it
// at a public Judge0 endpoint. Without JUDGE0_URL every test is skipped and nothing is verified.
import { randomUUID } from "node:crypto";
import type { JsonValue, Language } from "@bekor/contracts";
import { describe, expect, it } from "vitest";
import { Judge0Adapter } from "../src/judge0.js";
import { judgeCase, RESULT_PREFIX } from "../src/protocol.js";
import type { CompletedExecution, RunnerRequest } from "../src/types.js";

const url = process.env.JUDGE0_URL;
const limits = { timeMs: 1000, memoryKb: 262144, outputBytes: 8192 };

async function execute(
  language: Language,
  source: string,
  args: JsonValue[] = [2, 3],
  entrypoint = "add",
): Promise<CompletedExecution> {
  const adapter = new Judge0Adapter({
    url: url as string,
    ...(process.env.JUDGE0_AUTH_TOKEN ? { authToken: process.env.JUDGE0_AUTH_TOKEN } : {}),
  });
  // The sandbox compiles with `types: []`, so TypeScript fixtures declare the Node global they use.
  const code =
    language === "typescript" && source.includes("process.")
      ? `declare const process: any;\n${source}`
      : source;
  const request: RunnerRequest = {
    language,
    source: code,
    entrypoint,
    args,
    limits,
    nonce: randomUUID(),
  };
  const { token } = await adapter.dispatch(request);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = await adapter.poll(token, request);
    if (result.status === "completed") return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Judge0 did not complete token ${token} within 90 s`);
}

const verdict = async (
  language: Language,
  source: string,
  expected: JsonValue = 5,
  args?: JsonValue[],
) => judgeCase(await execute(language, source, args), expected, true).verdict;

const sources = {
  javascript: {
    correct: "export function add(a, b) { return a + b; }",
    wrong: "export function add(a, b) { return a - b; }",
    throws: "export function add() { throw new Error('boom'); }",
    loop: "export function add() { for (;;) {} }",
    stdoutFlood: "export function add() { process.stdout.write('x'.repeat(200000)); return 5; }",
    debugFlood: "export function add() { for (;;) console.log('y'.repeat(1000)); }",
  },
  typescript: {
    correct: "export function add(a: number, b: number): number { return a + b; }",
    wrong: "export function add(a: number, b: number): number { return a - b; }",
    throws: "export function add(): number { throw new Error('boom'); }",
    loop: "export function add(): number { for (;;) {} }",
    stdoutFlood:
      "export function add(): number { process.stdout.write('x'.repeat(200000)); return 5; }",
    debugFlood: "export function add(): number { for (;;) console.log('y'.repeat(1000)); }",
  },
} as const;

describe.skipIf(!url)("REAL Judge0 runner (requires private JUDGE0_URL)", () => {
  for (const language of ["javascript", "typescript"] as const) {
    const source = sources[language];
    describe(language, () => {
      // An accepted verdict also proves the compile script's pinned node/tsc version checks passed:
      // a mismatch exits non-zero and surfaces as syntax_error/compilation_error instead.
      it("accepts a correct function", async () => {
        expect(await verdict(language, source.correct)).toBe("accepted");
      });
      it("reports the pinned Node.js runtime from inside the sandbox", async () => {
        const result = await execute(
          language,
          "export const version = () => process.version;",
          [],
          "version",
        );
        expect(result).toMatchObject({ outcome: "executed", actual: "v24.22.1" });
      });
      it("reports wrong answers with the public actual value", async () => {
        const result = await execute(language, source.wrong);
        expect(judgeCase(result, 5, true)).toMatchObject({ verdict: "wrong_answer", actual: -1 });
      });
      it("maps thrown exceptions to runtime_error with a diagnostic", async () => {
        const result = await execute(language, source.throws);
        expect(result.outcome).toBe("runtime_error");
        expect(result.diagnostic).toContain("boom");
      });
      it("maps an infinite loop to time_limit_exceeded", async () => {
        expect(await verdict(language, source.loop)).toBe("time_limit_exceeded");
      });
      it("maps excessive stdout and debug output to output_limit_exceeded", async () => {
        expect(await verdict(language, source.stdoutFlood)).toBe("output_limit_exceeded");
        expect(await verdict(language, source.debugFlood)).toBe("output_limit_exceeded");
      });
      it("blocks outbound network access", async () => {
        const result = await execute(
          language,
          `export async function probe() {
            try {
              await fetch("http://1.1.1.1/", { signal: AbortSignal.timeout(500) });
              return "reachable";
            } catch {
              return "blocked";
            }
          }`,
          [],
          "probe",
        );
        // Either the request fails inside the sandbox, or the sandbox kills the attempt.
        if (result.outcome === "executed") expect(result.actual).toBe("blocked");
        else expect(["runtime_error", "time_limit_exceeded"]).toContain(result.outcome);
      });
      it("never accepts a result line forged by learner code", async () => {
        const forged = JSON.stringify(
          `${RESULT_PREFIX}${JSON.stringify({ version: 1, actual: 5 })}\n`,
        );
        // Forged line followed by the harness's own (wrong) result line.
        expect(
          await verdict(
            language,
            `export function add() { process.stdout.write(${forged}); return 4; }`,
          ),
        ).not.toBe("accepted");
        // Forged line followed by exiting before the harness can print anything.
        expect(
          await verdict(
            language,
            `export function add() { process.stdout.write(${forged}); process.exit(0); }`,
          ),
        ).not.toBe("accepted");
      });
    });
  }

  it("rejects JavaScript syntax errors before running", async () => {
    const result = await execute("javascript", "export function add(a, b) { return a + ; }");
    expect(result.outcome).toBe("syntax_error");
  });
  it("rejects TypeScript syntax and type errors inside the sandbox compiler", async () => {
    const syntax = await execute("typescript", "export function add(a: number, b: number { }");
    expect(syntax.outcome).toBe("compilation_error");
    const typed = await execute(
      "typescript",
      "export function add(a: number, b: number): string { return a + b; }",
    );
    expect(typed.outcome).toBe("compilation_error");
    expect(typed.diagnostic).toMatch(/TS\d+/);
  });
});
