// DEVELOPMENT-ONLY runner (plan task F05): one rootless Podman container per execution on this
// machine. It shares the host kernel, so it is weaker than the production runner and must be
// replaced or re-reviewed before production. Learner code never runs in the worker process.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "./harness.js";
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

export const PODMAN_RUNNER_IMAGE = "localhost/bekor-runner:node24.22.1-ts7.0.2";
export interface PodmanOptions {
  image?: string;
  /** Podman executable. */
  podman?: string;
  /** Host directory for per-execution input folders. */
  workRoot?: string;
  commandTimeoutMs?: number;
}

const LABEL = "io.bekor.runner";
const TOKEN = /^bekor-run-[0-9a-f-]{36}$/;
const RETENTION_MS = 30 * 60_000;
const TSC = "/opt/bekor/node_modules/.bin/tsc";
// Exit codes set by the container script, never reachable as a successful result.
const EXIT = { compile: 90, setup: 91, version: 92, timeout: 124, killed: 137, output: 86 };

interface Captured {
  code: number | null;
  stdout: string;
  stderr: string;
  overflow: boolean;
}

/** Runs a Podman CLI command (never learner code) with bounded output and time. */
function podman(
  bin: string,
  args: string[],
  timeoutMs: number,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let overflow = false;
    const collect = (chunks: Buffer[]) => {
      let size = 0;
      return (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          overflow = true;
          child.kill("SIGKILL");
        } else chunks.push(chunk);
      };
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        overflow,
      }),
    );
  });
}

/** Container entry script. The input (nonce + args) is opened, then deleted before learner code loads. */
function script(request: RunnerRequest): string {
  const wallMs = request.limits.timeMs + 500;
  const compile =
    request.language === "typescript"
      ? `test "$(${TSC} --version)" = 'Version 7.0.2' || exit ${EXIT.version}
timeout -s KILL 20 ${TSC} --project tsconfig.json >&2 || exit ${EXIT.compile}`
      : `node --check solution.js || exit ${EXIT.compile}`;
  return `set -u
exec 3</in/input.json || exit ${EXIT.setup}
rm -f /in/input.json
cp -R /in/. /work/ && rm -rf /in/* || exit ${EXIT.setup}
cd /work
test "$(node --version)" = v24.22.1 || exit ${EXIT.version}
${compile}
start=$(date +%s%N)
timeout -s KILL ${(wallMs / 1000).toFixed(3)} node --max-old-space-size=128 harness.mjs <&3 3<&-
code=$?
if [ "$code" -eq ${EXIT.killed} ] && [ $(( ($(date +%s%N) - start) / 1000000 )) -ge ${wallMs - 50} ]; then exit ${EXIT.timeout}; fi
exit "$code"
`;
}

export class PodmanAdapter implements RunnerAdapter {
  private readonly bin: string;
  private readonly image: string;
  private readonly workRoot: string;
  private readonly timeoutMs: number;
  private lastSweep = 0;

  constructor(options: PodmanOptions = {}) {
    this.bin = options.podman ?? "podman";
    this.image = options.image ?? PODMAN_RUNNER_IMAGE;
    this.workRoot =
      options.workRoot ?? join(tmpdir(), `bekor-runner-${process.getuid?.() ?? "user"}`);
    this.timeoutMs = options.commandTimeoutMs ?? 30_000;
  }

  private async exec(args: string[], maxBytes?: number): Promise<Captured> {
    try {
      return await podman(this.bin, args, this.timeoutMs, maxBytes);
    } catch {
      throw new RunnerInfrastructureError("Podman is unavailable.");
    }
  }

  /** Removes finished containers and input folders past retention. Best effort, at most once a minute. */
  private async sweep(): Promise<void> {
    if (Date.now() - this.lastSweep < 60_000) return;
    this.lastSweep = Date.now();
    await this.exec([
      "container",
      "prune",
      "--force",
      "--filter",
      `label=${LABEL}`,
      "--filter",
      `until=${RETENTION_MS / 60_000}m`,
    ]).catch(() => undefined);
    for (const name of await readdir(this.workRoot).catch(() => [] as string[])) {
      if (!TOKEN.test(name)) continue;
      const path = join(this.workRoot, name);
      const info = await stat(path).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > RETENTION_MS)
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async dispatch(request: RunnerRequest): Promise<{ token: string }> {
    const files = createWorkspace(request);
    const token = `bekor-run-${randomUUID()}`;
    const dir = join(this.workRoot, token);
    await this.sweep();
    try {
      await mkdir(this.workRoot, { recursive: true, mode: 0o700 });
      await mkdir(dir, { mode: 0o700 });
      for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
      await writeFile(
        join(dir, "input.json"),
        JSON.stringify({ nonce: request.nonce, args: request.args }),
      );
    } catch {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw new RunnerInfrastructureError("Runner could not prepare the execution.");
    }
    const memoryKb = request.limits.memoryKb + 131_072; // headroom for Node/tsc startup
    const ids = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    const result = await this.exec([
      "run",
      "--detach",
      "--name",
      token,
      "--label",
      `${LABEL}=1`,
      "--pull=never",
      "--network=none",
      "--read-only",
      "--userns=keep-id",
      "--user",
      ids,
      "--cap-drop=all",
      "--security-opt=no-new-privileges",
      `--memory=${memoryKb}k`,
      `--memory-swap=${memoryKb}k`,
      "--pids-limit=128",
      "--cpus=1",
      "--timeout=60",
      "--tmpfs=/work:rw,exec,nosuid,nodev,size=16m,mode=1777",
      "--tmpfs=/tmp:rw,nosuid,nodev,size=8m",
      `--volume=${dir}:/in:Z`,
      "--log-opt=max-size=1mb",
      this.image,
      "bash",
      "-c",
      script(request),
    ]);
    if (result.code !== 0) {
      await this.exec(["rm", "--force", token]).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      const missing = /image not known|no such image/i.test(result.stderr);
      throw new RunnerInfrastructureError(
        missing
          ? `Runner image ${this.image} is missing; build it from infra/runner.`
          : "Podman failed to start the execution.",
        !missing,
      );
    }
    return { token };
  }

  async poll(
    token: string,
    request: Pick<RunnerRequest, "language" | "limits" | "nonce">,
  ): Promise<RunnerResult> {
    if (!TOKEN.test(token))
      throw new RunnerInfrastructureError("Invalid persisted runner token.", false);
    const inspect = await this.exec(["container", "inspect", "--format", "{{json .State}}", token]);
    if (inspect.code !== 0)
      throw /no such container/i.test(inspect.stderr)
        ? new RunnerInfrastructureError("Execution record is missing or expired.", false)
        : new RunnerInfrastructureError("Podman failed to inspect the execution.");
    let state: { Status?: unknown; ExitCode?: unknown };
    try {
      state = JSON.parse(inspect.stdout);
    } catch {
      throw new RunnerInfrastructureError("Invalid runner state.");
    }
    if (["created", "configured", "initialized"].includes(state.Status as string))
      return { status: "queued" };
    if (["running", "paused", "stopping"].includes(state.Status as string))
      return { status: "running" };
    if (
      !["exited", "stopped"].includes(state.Status as string) ||
      typeof state.ExitCode !== "number"
    )
      throw new RunnerInfrastructureError("Unknown runner state.");
    await rm(join(this.workRoot, token), { recursive: true, force: true }).catch(() => undefined);

    const code = state.ExitCode;
    if (code === EXIT.timeout) return { status: "completed", outcome: "time_limit_exceeded" };
    if (code === EXIT.output) return { status: "completed", outcome: "output_limit_exceeded" };
    if (code === EXIT.setup || code === EXIT.version)
      throw new RunnerInfrastructureError("Runner image or setup is invalid.", false);
    const logs = await this.exec(["logs", token]);
    if (logs.overflow) return { status: "completed", outcome: "output_limit_exceeded" };
    if (logs.code !== 0)
      throw new RunnerInfrastructureError("Podman failed to read execution output.");
    const { stdout, stderr } = logs;
    if (code === EXIT.compile)
      return {
        status: "completed",
        outcome: request.language === "typescript" ? "compilation_error" : "syntax_error",
        diagnostic: diagnostic(stderr.replaceAll("/work/", "")),
      };
    if (
      Buffer.byteLength(stdout) > request.limits.outputBytes ||
      Buffer.byteLength(stderr) > MAX_DEBUG_BYTES
    )
      return { status: "completed", outcome: "output_limit_exceeded" };
    if (code === EXIT.killed)
      return {
        status: "completed",
        outcome: "runtime_error",
        diagnostic: "Memory limit exceeded.",
      };
    if (code !== 0)
      return { status: "completed", outcome: "runtime_error", diagnostic: diagnostic(stderr) };
    const result = parseResult(stdout, request.limits.outputBytes, request.nonce);
    return { ...result, ...(stderr ? { diagnostic: diagnostic(stderr) } : {}) };
  }
}
