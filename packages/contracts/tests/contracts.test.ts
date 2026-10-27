import { describe, expect, it } from "vitest";
import { isJsonValue, submissionCreateSchema } from "../src/index.js";

describe("bounded public contracts", () => {
  it("rejects unsupported values and deep or cyclic graphs", () => {
    for (const value of [
      undefined,
      NaN,
      Infinity,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      1n,
      new Date(),
      new Map(),
      [undefined],
      new Array(2),
    ])
      expect(isJsonValue(value)).toBe(false);
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(isJsonValue(cycle)).toBe(false);
    const symbolic = Object.assign([1], { [Symbol("extra")]: 2 });
    expect(isJsonValue(symbolic)).toBe(false);
    expect(isJsonValue({ a: [true, 3, null], b: "ok" })).toBe(true);
  });
  it("allows only the selected language file and enforces UTF8 bytes", () => {
    const input = {
      exerciseId: "array-total",
      exerciseVersion: "1",
      language: "javascript",
      files: { "solution.js": "export const solve = () => 1;" },
      mode: "submit",
      idempotencyKey: "abcdefgh",
    };
    expect(submissionCreateSchema.safeParse(input).success).toBe(true);
    expect(
      submissionCreateSchema.safeParse({ ...input, files: { "../solution.js": "oops" } }).success,
    ).toBe(false);
    expect(
      submissionCreateSchema.safeParse({ ...input, files: { "solution.js": "💥".repeat(20_000) } })
        .success,
    ).toBe(false);
  });
});
