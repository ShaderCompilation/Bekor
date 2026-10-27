import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { publicExerciseSchema } from "@bekor/contracts";
import { describe, expect, it } from "vitest";
import {
  authoredExerciseSchema,
  contentHash,
  createDownload,
  getExercise,
  getExerciseBySlug,
  listExercises,
  toPublicExercise,
} from "../src/index.js";
import { compareJson } from "../src/public.js";

describe("authored exercises and public packages", () => {
  it("validates three original exercises with matching language semantics and immutable lookup", () => {
    const exercises = listExercises();
    expect(exercises).toHaveLength(3);
    for (const exercise of exercises) {
      expect(authoredExerciseSchema.safeParse(exercise).success).toBe(true);
      expect(getExercise(exercise.public.id, exercise.public.version)).toEqual(exercise);
      expect(getExerciseBySlug(exercise.public.slug)).toEqual(exercise);
      expect(contentHash(exercise)).toMatch(/^[a-f0-9]{64}$/);
      exercise.public.title = "Mutated";
      expect(getExercise(exercise.public.id, exercise.public.version)?.public.title).not.toBe(
        "Mutated",
      );
    }
    expect(getExercise("cumulative-sums", "unknown")).toBeUndefined();
  });

  it("allowlists public data and paths without additional cases, explanations or reference sources", () => {
    for (const exercise of listExercises())
      for (const language of ["javascript", "typescript"] as const) {
        const publicExercise = toPublicExercise(exercise);
        expect(publicExerciseSchema.safeParse(publicExercise).success).toBe(true);
        const bundle = createDownload(exercise, language, "https://bekor.example");
        const permitted = [
          "README.md",
          "package.json",
          ".bekor/exercise.json",
          ".bekor/public.json",
          "public.test.mjs",
          language === "javascript" ? "solution.js" : "solution.ts",
          ...(language === "typescript" ? ["tsconfig.json"] : []),
        ];
        expect(Object.keys(bundle.files).sort()).toEqual(permitted.sort());
        expect(JSON.parse(bundle.files[".bekor/public.json"] ?? "")).toEqual(publicExercise);
        expect(JSON.parse(bundle.files[".bekor/exercise.json"] ?? "")).toMatchObject({
          exerciseId: exercise.public.id,
          exerciseVersion: exercise.public.version,
          language,
          permittedFiles: [exercise.public.variants[language].filename],
        });
        const packed = JSON.stringify(bundle);
        expect(packed).not.toContain("referenceSolutions");
        expect(packed).not.toContain("privateTests");
        expect(packed).not.toContain(JSON.stringify(exercise.explanation));
        expect(packed).not.toContain(JSON.stringify(exercise.referenceSolutions[language]));
        expect(createDownload(exercise, language, "https://bekor.example")).toEqual(bundle);
      }
  });

  it("rejects unsafe prose, inconsistent variants, case overflow and invalid origins", () => {
    const exercise = listExercises()[0];
    expect(exercise).toBeDefined();
    if (!exercise) return;
    const unsafe = structuredClone(exercise);
    unsafe.public.description = "<script>alert(1)</script>";
    expect(authoredExerciseSchema.safeParse(unsafe).success).toBe(false);
    unsafe.public.description = "[click](javascript:alert(1))";
    expect(authoredExerciseSchema.safeParse(unsafe).success).toBe(false);
    const mismatch = structuredClone(exercise);
    mismatch.public.variants.typescript.filename = "solution.js";
    expect(authoredExerciseSchema.safeParse(mismatch).success).toBe(false);
    const overflow = structuredClone(exercise);
    overflow.privateTests = Array.from({ length: 32 }, () => ({ args: [], expected: null }));
    expect(authoredExerciseSchema.safeParse(overflow).success).toBe(false);
    for (const origin of [
      "file:///tmp",
      "https://user:password@example.com",
      "https://example.com/path",
    ])
      expect(() => createDownload(exercise, "javascript", origin)).toThrow();
  });

  it("uses structural comparison with ordered arrays, unordered own keys and distinct primitives", () => {
    expect(compareJson({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 })).toBe(true);
    expect(compareJson([1, 2], [2, 1])).toBe(false);
    expect(compareJson(1, true)).toBe(false);
    expect(compareJson({ constructor: 1 }, {})).toBe(false);
  });
});

describe("trusted authored references (local checks, not isolated runner verification)", () => {
  for (const exercise of listExercises())
    for (const language of ["javascript", "typescript"] as const) {
      it(`${exercise.public.id} ${language}: compiled reference passes generated public tests and authored cases`, () => {
        const directory = mkdtempSync(join(tmpdir(), "bekor-authored-"));
        try {
          const bundle = createDownload(exercise, language, "https://bekor.example");
          for (const [name, content] of Object.entries(bundle.files)) {
            const destination = join(directory, name);
            mkdirSync(dirname(destination), { recursive: true });
            writeFileSync(destination, content);
          }
          writeFileSync(
            join(directory, exercise.public.variants[language].filename),
            exercise.referenceSolutions[language],
          );
          if (language === "typescript")
            execFileSync(
              process.execPath,
              [resolve("node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"],
              { cwd: directory, timeout: 15000, stdio: "pipe" },
            );
          execFileSync(process.execPath, ["--test", "public.test.mjs"], {
            cwd: directory,
            timeout: 15000,
            stdio: "pipe",
          });
          // This fixture executes repository-authored reference code only. Uploaded learner sources never enter this path.
          writeFileSync(
            join(directory, "private-check.mjs"),
            `import assert from 'node:assert/strict';\nimport { ${exercise.public.variants[language].entrypoint} as solve } from './solution.js';\nfor (const c of JSON.parse(${JSON.stringify(JSON.stringify(exercise.privateTests))})) assert.deepEqual(await solve(...c.args), c.expected);\n`,
          );
          execFileSync(process.execPath, ["private-check.mjs"], {
            cwd: directory,
            timeout: 15000,
            stdio: "pipe",
          });
          // A broken constant result must fail public tests; checks must not merely load source.
          writeFileSync(
            join(directory, "solution.js"),
            `export function ${exercise.public.variants[language].entrypoint}() { return null; }`,
          );
          expect(() =>
            execFileSync(process.execPath, ["--test", "public.test.mjs"], {
              cwd: directory,
              timeout: 15000,
              stdio: "pipe",
            }),
          ).toThrow();
          expect(readFileSync(join(directory, ".bekor/public.json"), "utf8")).toBe(
            bundle.files[".bekor/public.json"],
          );
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
});
