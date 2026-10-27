import { createArchive } from "./harness.js";
import {
  sanitizeDiagnostic as diagnostic,
  MAX_DEBUG_BYTES,
  MAX_RESPONSE_BYTES,
  parseResult,
} from "./protocol.js";
import {
  type RunnerAdapter,
  RunnerInfrastructureError,
  type RunnerRequest,
  type RunnerResult,
} from "./types.js";

export interface Judge0Options {
  url: string;
  authToken?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
const TOKEN = /^[a-zA-Z0-9-]{1,128}$/;
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new RunnerInfrastructureError("Invalid runner response.");
  return value as Record<string, unknown>;
}
function decode(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (
    typeof value !== "string" ||
    value.length > MAX_RESPONSE_BYTES ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new RunnerInfrastructureError("Invalid runner output encoding.");
  return Buffer.from(value, "base64").toString("utf8");
}
export class Judge0Adapter implements RunnerAdapter {
  private readonly base: URL;
  private readonly fetcher: typeof globalThis.fetch;
  constructor(private readonly options: Judge0Options) {
    this.base = new URL(options.url);
    if (
      !["https:", "http:"].includes(this.base.protocol) ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash
    )
      throw new Error("JUDGE0_URL must be an HTTP(S) URL without credentials, query or fragment.");
    if (!this.base.pathname.endsWith("/")) this.base.pathname += "/";
    this.fetcher = options.fetch ?? globalThis.fetch;
  }
  private async request(path: string, body?: object): Promise<Record<string, unknown>> {
    try {
      const response = await this.fetcher(new URL(path, this.base), {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          ...(this.options.authToken ? { "X-Auth-Token": this.options.authToken } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
        redirect: "error",
      });
      if (!response.ok)
        throw new RunnerInfrastructureError(
          "Runner service rejected the request.",
          response.status === 429 || response.status >= 500,
          Boolean(body && response.status >= 500),
        );
      const reader = response.body?.getReader();
      if (!reader)
        throw new RunnerInfrastructureError("Empty runner response.", true, Boolean(body));
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES)
            throw new RunnerInfrastructureError(
              "Runner response exceeds policy.",
              true,
              Boolean(body),
            );
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (error) {
      if (error instanceof RunnerInfrastructureError) throw error;
      throw new RunnerInfrastructureError(
        "Runner service unavailable or returned malformed data.",
        true,
        Boolean(body),
      );
    }
  }
  async dispatch(request: RunnerRequest): Promise<{ token: string }> {
    const archive = createArchive(request);
    const response = await this.request("submissions?base64_encoded=true&wait=false", {
      language_id: 89,
      additional_files: archive,
      stdin: Buffer.from(JSON.stringify({ nonce: request.nonce, args: request.args })).toString(
        "base64",
      ),
      cpu_time_limit: request.limits.timeMs / 1000,
      cpu_extra_time: 0,
      wall_time_limit: Math.max(2, (request.limits.timeMs / 1000) * 3),
      memory_limit: request.limits.memoryKb,
      max_processes_and_or_threads: 32,
      max_file_size: Math.ceil(request.limits.outputBytes / 1024),
      enable_network: false,
      enable_per_process_and_thread_time_limit: false,
      enable_per_process_and_thread_memory_limit: false,
      redirect_stderr_to_stdout: false,
      number_of_runs: 1,
    });
    if (typeof response.token !== "string" || !TOKEN.test(response.token))
      throw new RunnerInfrastructureError("Runner omitted a valid execution token.", true, true);
    return { token: response.token };
  }
  async poll(
    token: string,
    request: Pick<RunnerRequest, "language" | "limits" | "nonce">,
  ): Promise<RunnerResult> {
    if (!TOKEN.test(token))
      throw new RunnerInfrastructureError("Invalid persisted runner token.", false);
    const response = await this.request(
      `submissions/${encodeURIComponent(token)}?base64_encoded=true&fields=status,stdout,stderr,compile_output,exit_code,exit_signal,time,memory`,
    );
    const status = object(response.status).id;
    if (status === 1) return { status: "queued" };
    if (status === 2) return { status: "running" };
    if (status === 13 || status === 14)
      throw new RunnerInfrastructureError("Runner execution infrastructure failed.");
    if (status === 5) return { status: "completed", outcome: "time_limit_exceeded" };
    if (status === 10 || response.exit_code === 86)
      return { status: "completed", outcome: "output_limit_exceeded" };
    const stdout = decode(response.stdout),
      stderr = decode(response.stderr),
      compile = decode(response.compile_output);
    if (
      Buffer.byteLength(stdout) > request.limits.outputBytes ||
      Buffer.byteLength(stderr) > MAX_DEBUG_BYTES
    )
      return { status: "completed", outcome: "output_limit_exceeded" };
    if (status === 6)
      return {
        status: "completed",
        outcome: request.language === "typescript" ? "compilation_error" : "syntax_error",
        diagnostic: diagnostic(compile),
      };
    if ([7, 8, 9, 11, 12].includes(status as number))
      return { status: "completed", outcome: "runtime_error", diagnostic: diagnostic(stderr) };
    if (status !== 3 && status !== 4) throw new RunnerInfrastructureError("Unknown runner status.");
    const result = parseResult(stdout, request.limits.outputBytes, request.nonce);
    return { ...result, ...(stderr ? { diagnostic: diagnostic(stderr) } : {}) };
  }
}
