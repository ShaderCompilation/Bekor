import { stripVTControlCharacters } from "node:util";
import { isJsonValue, type JsonValue } from "@bekor/contracts";

export { isJsonValue } from "@bekor/contracts";

import type { CompletedExecution, JudgedCase } from "./types.js";

export const MAX_SOURCE_BYTES = 65_536;
export const MAX_OUTPUT_BYTES = 32_768;
export const MAX_DEBUG_BYTES = 8_192;
export const MAX_RESPONSE_BYTES = 262_144;
export const RUNTIME_VERSION = "node-24.22.1-ts-7.0.2";
export const RESULT_PREFIX = "BEKOR_RESULT_V1:";

/** Strips terminal escapes and control characters and bounds the length. */
export function sanitizeDiagnostic(value: string): string {
  return [...stripVTControlCharacters(value)]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join("")
    .slice(0, MAX_DEBUG_BYTES);
}

export function compareJson(actual: JsonValue, expected: JsonValue): boolean {
  if (actual === expected) return true;
  if (
    actual === null ||
    expected === null ||
    typeof actual !== "object" ||
    typeof expected !== "object"
  )
    return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return (
      actual.length === expected.length &&
      actual.every((value, i) => compareJson(value, expected[i] as JsonValue))
    );
  }
  const a = actual as Record<string, JsonValue>;
  const b = expected as Record<string, JsonValue>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) => Object.hasOwn(b, key) && compareJson(a[key] as JsonValue, b[key] as JsonValue),
    )
  );
}

export function parseResult(
  stdout: string,
  outputBytes: number,
  nonce: string,
): CompletedExecution {
  if (Buffer.byteLength(stdout) > outputBytes)
    return { status: "completed", outcome: "output_limit_exceeded" };
  const trimmed = stdout.trim();
  if (!trimmed.startsWith(RESULT_PREFIX) || trimmed.includes("\n"))
    return {
      status: "completed",
      outcome: "runtime_error",
      diagnostic: "Missing or malformed function result.",
    };
  try {
    const envelope: unknown = JSON.parse(trimmed.slice(RESULT_PREFIX.length));
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope))
      throw new Error();
    const result = envelope as Record<string, unknown>;
    if (
      Object.keys(result).length !== 3 ||
      result.version !== 1 ||
      typeof result.nonce !== "string" ||
      result.nonce !== nonce ||
      !Object.hasOwn(result, "actual") ||
      !isJsonValue(result.actual)
    )
      throw new Error();
    return { status: "completed", outcome: "executed", actual: result.actual };
  } catch {
    return {
      status: "completed",
      outcome: "runtime_error",
      diagnostic: "Unsupported or malformed function result.",
    };
  }
}

export function judgeCase(
  result: CompletedExecution,
  expected: JsonValue,
  isPublic: boolean,
): JudgedCase {
  const verdict =
    result.outcome === "executed"
      ? Object.hasOwn(result, "actual") && compareJson(result.actual as JsonValue, expected)
        ? "accepted"
        : "wrong_answer"
      : result.outcome;
  // Hidden inputs can appear in stdout, exceptions and compiler diagnostics: never persist them publicly.
  return {
    passed: verdict === "accepted",
    verdict,
    ...(isPublic && result.actual !== undefined ? { actual: result.actual } : {}),
    ...(isPublic && result.diagnostic
      ? { diagnostic: result.diagnostic.slice(0, MAX_DEBUG_BYTES) }
      : {}),
  };
}
