import { strToU8, zipSync } from "fflate";
import {
  isJsonValue,
  MAX_DEBUG_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_SOURCE_BYTES,
  RESULT_PREFIX,
} from "./protocol.js";
import type { RunnerRequest } from "./types.js";

export const COMPILER_OPTIONS = {
  target: "ES2022",
  module: "NodeNext",
  moduleResolution: "NodeNext",
  strict: true,
  noEmitOnError: true,
  skipLibCheck: false,
  types: [],
  lib: ["ES2022", "DOM"],
  outDir: ".",
  rootDir: ".",
} as const;

export const NONCE = /^[A-Za-z0-9-]{16,64}$/;

export function validateRequest(request: RunnerRequest): void {
  if (!["javascript", "typescript"].includes(request.language))
    throw new Error("Unsupported runner language.");
  if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(request.entrypoint))
    throw new Error("Invalid entrypoint.");
  if (typeof request.nonce !== "string" || !NONCE.test(request.nonce))
    throw new Error("Invalid execution nonce.");
  if (Buffer.byteLength(request.source) > MAX_SOURCE_BYTES)
    throw new Error("Source limit exceeded.");
  if (
    !Array.isArray(request.args) ||
    !isJsonValue(request.args) ||
    Buffer.byteLength(JSON.stringify(request.args)) > MAX_OUTPUT_BYTES
  )
    throw new Error("Invalid bounded JSON arguments.");
  const { timeMs, memoryKb, outputBytes } = request.limits;
  if (
    ![timeMs, memoryKb, outputBytes].every(Number.isSafeInteger) ||
    timeMs < 100 ||
    timeMs > 2000 ||
    memoryKb < 16384 ||
    memoryKb > 262144 ||
    outputBytes < 1024 ||
    outputBytes > MAX_OUTPUT_BYTES
  )
    throw new Error("Execution limits outside server policy.");
}

// Literal source avoids serializing transpiler-injected helpers from Function.toString().
const SANDBOX_JSON_VALIDATOR = `(value) => {
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 10000 || depth > 32) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'string') return item.length <= 32768;
    if (typeof item === 'number') return Number.isSafeInteger(item);
    if (Array.isArray(item)) {
      if (item.length > 10000 || Object.keys(item).length !== item.length) return false;
      for (let i = 0; i < item.length; i++) if (!Object.hasOwn(item, i) || !visit(item[i], depth + 1)) return false;
      return true;
    }
    if (typeof item !== 'object' || item === undefined) return false;
    const proto = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== null) return false;
    if (Reflect.ownKeys(item).length !== Object.keys(item).length) return false;
    return Object.entries(item).every(([key, entry]) => key.length <= 1024 && visit(entry, depth + 1));
  };
  return visit(value, 0);
}`;

// This text is sent to the isolated runner. It is NEVER evaluated by the API or worker.
// Forgery defenses: the result envelope carries a nonce that is read from stdin and the stream
// closed before learner code loads, and only the harness can exit with status 0.
export function makeHarness(entrypoint: string, outputBytes: number): string {
  return `import { closeSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { formatWithOptions } from 'node:util';
const write = writeSync;
const stringify = JSON.stringify.bind(JSON);
const byteLength = Buffer.byteLength.bind(Buffer);
const hardExit = process.reallyExit.bind(process);
const input = JSON.parse(readFileSync(0, 'utf8'));
closeSync(0);
try { rmSync('stdin.txt', { force: true }); } catch {}
const nonce = String(input.nonce);
const args = input.args;
const fail = (code) => hardExit(code);
process.exit = () => fail(87);
process.reallyExit = () => fail(87);
let debugBytes = 0;
for (const name of ['log', 'error', 'warn', 'info', 'debug', 'dir', 'trace']) {
  console[name] = (...values) => {
    const text = formatWithOptions({ depth: 3, maxArrayLength: 30, maxStringLength: 1000 }, ...values) + '\\n';
    debugBytes += byteLength(text);
    if (debugBytes > ${MAX_DEBUG_BYTES}) fail(86);
    write(2, text);
  };
}
const valid = ${SANDBOX_JSON_VALIDATOR};
try {
  const solution = await import('./solution.js');
  const fn = solution[${JSON.stringify(entrypoint)}];
  if (typeof fn !== 'function') throw new Error('Missing exported function.');
  const actual = await fn(...args);
  if (!valid(actual)) throw new Error('Result is not supported bounded JSON.');
  const text = ${JSON.stringify(RESULT_PREFIX)} + stringify({ version: 1, nonce, actual });
  if (byteLength(text) > ${outputBytes}) fail(86);
  write(1, text + '\\n');
  hardExit(0);
} catch (error) {
  try { write(2, (error instanceof Error ? String(error.message) : 'Function failed.').slice(0, 2000) + '\\n'); } catch {}
  fail(1);
}
`;
}

/** Files shared by every adapter: the solution, module marker, harness and (TS) compiler config. */
export function createWorkspace(request: RunnerRequest): Record<string, string> {
  validateRequest(request);
  const files: Record<string, string> = {
    [request.language === "typescript" ? "solution.ts" : "solution.js"]: request.source,
    "package.json": '{"type":"module"}',
    "harness.mjs": makeHarness(request.entrypoint, request.limits.outputBytes),
  };
  if (request.language === "typescript")
    files["tsconfig.json"] = JSON.stringify({
      compilerOptions: COMPILER_OPTIONS,
      files: ["solution.ts"],
      exclude: [],
    });
  return files;
}

export function createArchive(request: RunnerRequest): string {
  const compile =
    request.language === "typescript"
      ? `#!/bin/bash\nset -eu\nexport PATH=/usr/local/bekor/bin:$PATH\ntest "$(node --version)" = v24.22.1\ntest "$(/usr/local/bekor/node_modules/.bin/tsc --version)" = 'Version 7.0.2'\nexec /usr/local/bekor/node_modules/.bin/tsc --project tsconfig.json\n`
      : '#!/bin/bash\nset -eu\ntest "$(/usr/local/bekor/bin/node --version)" = v24.22.1\nexec /usr/local/bekor/bin/node --check solution.js\n';
  const files: Record<string, Uint8Array> = {
    ...Object.fromEntries(
      Object.entries(createWorkspace(request)).map(([name, text]) => [name, strToU8(text)]),
    ),
    compile: strToU8(compile),
    run: strToU8(
      "#!/bin/bash\nset -eu\nexec /usr/local/bekor/bin/node --max-old-space-size=128 harness.mjs\n",
    ),
  };
  return Buffer.from(zipSync(files, { level: 0 })).toString("base64");
}
