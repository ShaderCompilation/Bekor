import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { createArchive, makeHarness } from "../src/harness.js";
import { Judge0Adapter } from "../src/judge0.js";
import { compareJson, judgeCase, parseResult, RESULT_PREFIX } from "../src/protocol.js";
import { RunnerInfrastructureError, type RunnerRequest } from "../src/types.js";

const request: RunnerRequest = {
  language: "javascript",
  source: "export const solve = (value) => value;",
  entrypoint: "solve",
  args: [1],
  limits: { timeMs: 1000, memoryKb: 262144, outputBytes: 8192 },
  nonce: "nonce-0123456789abcdef",
};
const encoded = (value: string) => Buffer.from(value).toString("base64");
const provider = (value: object) =>
  vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(value)));

describe("trusted result protocol (no learner code execution)", () => {
  it("compares object key order structurally and distinguishes types and array order", () => {
    expect(compareJson({ a: 1, b: [2] }, { b: [2], a: 1 })).toBe(true);
    expect(compareJson(true, 1)).toBe(false);
    expect(compareJson([1, 2], [2, 1])).toBe(false);
    expect(compareJson({}, [])).toBe(false);
  });
  it("rejects malformed, duplicate, unsupported and oversized results", () => {
    for (const text of [
      "",
      `${RESULT_PREFIX}{"version":1,"nonce":"nonce-0123456789abcdef","actual":1}\n${RESULT_PREFIX}{"version":1,"nonce":"nonce-0123456789abcdef","actual":2}`,
      `${RESULT_PREFIX}{"version":1,"nonce":"nonce-0123456789abcdef","actual":1.5}`,
      `${RESULT_PREFIX}{"version":1,"nonce":"nonce-0123456789abcdef","actual":1,"passed":true}`,
    ])
      expect(parseResult(text, 8192, request.nonce).outcome).toBe("runtime_error");
    expect(parseResult("x".repeat(9000), 8192, request.nonce).outcome).toBe(
      "output_limit_exceeded",
    );
    expect(
      parseResult(
        `${RESULT_PREFIX}{"version":1,"nonce":"nonce-0123456789abcdef","actual":null}`,
        8192,
        request.nonce,
      ),
    ).toEqual({
      status: "completed",
      outcome: "executed",
      actual: null,
    });
  });
  it("never retains actual or diagnostics for private tests", () => {
    expect(
      judgeCase(
        { status: "completed", outcome: "executed", actual: "secret", diagnostic: "secret" },
        "other",
        false,
      ),
    ).toEqual({ passed: false, verdict: "wrong_answer" });
  });
});
describe("Judge0 HTTP adapter with fake provider responses", () => {
  it("dispatches one isolated case with disabled network and no expected answer", async () => {
    const fetcher = provider({ token: "token-1" });
    await new Judge0Adapter({
      url: "http://runner/",
      authToken: "credential",
      fetch: fetcher,
    }).dispatch(request);
    const [url, options] = fetcher.mock.calls[0]!;
    const body = JSON.parse(options!.body as string);
    expect(String(url)).toContain("base64_encoded=true");
    expect(body).toMatchObject({ language_id: 89, enable_network: false, number_of_runs: 1 });
    expect(body).not.toHaveProperty("expected_output");
    expect(options!.redirect).toBe("error");
    const archive = unzipSync(Buffer.from(body.additional_files, "base64"));
    expect(strFromU8(archive["solution.js"]!)).toBe(request.source);
    expect(Object.keys(archive)).not.toContain("expected.json");
  });
  it("archives fixed compiler configuration and never embeds transform helpers", () => {
    const files = unzipSync(
      Buffer.from(createArchive({ ...request, language: "typescript" }), "base64"),
    );
    expect(JSON.parse(strFromU8(files["tsconfig.json"]!)).compilerOptions).toMatchObject({
      strict: true,
      noEmitOnError: true,
      types: [],
    });
    expect(strFromU8(files.compile!)).toContain("Version 7.0.2");
    expect(makeHarness("solve", 8192, request.nonce)).not.toMatch(/__name|__vite|__vitest/);
  });
  it.each([
    [1, "queued"],
    [2, "running"],
  ])("maps pending status %s", async (id, status) => {
    expect(
      await new Judge0Adapter({ url: "http://runner", fetch: provider({ status: { id } }) }).poll(
        "token",
        request,
      ),
    ).toEqual({ status });
  });
  it.each([
    [5, "time_limit_exceeded"],
    [6, "syntax_error"],
    [9, "runtime_error"],
    [10, "output_limit_exceeded"],
  ])("maps terminal status %s without guessing memory errors", async (id, outcome) => {
    expect(
      await new Judge0Adapter({
        url: "http://runner",
        fetch: provider({
          status: { id },
          stderr: encoded("details"),
          compile_output: encoded("diagnostic"),
        }),
      }).poll("token", request),
    ).toMatchObject({ status: "completed", outcome });
  });
  it("maps TypeScript compilation and valid actual output", async () => {
    expect(
      await new Judge0Adapter({
        url: "http://runner",
        fetch: provider({ status: { id: 6 } }),
      }).poll("token", { ...request, language: "typescript" }),
    ).toMatchObject({ outcome: "compilation_error" });
    expect(
      await new Judge0Adapter({
        url: "http://runner",
        fetch: provider({
          status: { id: 3 },
          stdout: encoded(
            `${RESULT_PREFIX}{"version":1,"nonce":"nonce-0123456789abcdef","actual":1}`,
          ),
        }),
      }).poll("token", request),
    ).toMatchObject({ outcome: "executed", actual: 1 });
  });
  it("treats provider internal errors and malformed responses as infrastructure errors", async () => {
    for (const response of [
      { status: { id: 13 } },
      { status: { id: 99 } },
      { status: { id: 3 }, stdout: "not base64" },
    ])
      await expect(
        new Judge0Adapter({ url: "http://runner", fetch: provider(response) }).poll(
          "token",
          request,
        ),
      ).rejects.toBeInstanceOf(RunnerInfrastructureError);
  });
  it("records dispatch ambiguity and never reflects provider body or credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("credential secret"));
    await expect(
      new Judge0Adapter({ url: "http://runner", fetch: fetcher }).dispatch(request),
    ).rejects.toMatchObject({
      uncertain: true,
      message: "Runner service unavailable or returned malformed data.",
    });
  });
  it("preserves normal diagnostics while removing terminal control sequences", async () => {
    const result = await new Judge0Adapter({
      url: "http://runner",
      fetch: provider({
        status: { id: 11 },
        stderr: encoded("\u001b[31mFailure: bad value 123\u001b[0m\u0000\n"),
      }),
    }).poll("token", request);
    expect(result).toMatchObject({ diagnostic: "Failure: bad value 123\n" });
  });
  it("bounds streamed response sizes", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(262145)));
    await expect(
      new Judge0Adapter({ url: "http://runner", fetch: fetcher }).poll("token", request),
    ).rejects.toThrow("exceeds policy");
  });
});
