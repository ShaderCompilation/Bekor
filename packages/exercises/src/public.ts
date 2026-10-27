import {
  type Download,
  isJsonValue,
  type JsonValue,
  type Language,
  type PublicExercise,
  publicExerciseSchema,
} from "@bekor/contracts";

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
  if (Array.isArray(actual) && Array.isArray(expected))
    return (
      actual.length === expected.length &&
      actual.every((value, i) => compareJson(value, expected[i] as JsonValue))
    );
  const a = actual as Record<string, JsonValue>,
    b = expected as Record<string, JsonValue>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) => Object.hasOwn(b, key) && compareJson(a[key] as JsonValue, b[key] as JsonValue),
    )
  );
}

export function createPublicDownload(
  exercise: PublicExercise,
  language: Language,
  apiOrigin: string,
): Download {
  const publicExercise = publicExerciseSchema.parse(exercise);
  const origin = new URL(apiOrigin);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("API origin must be an HTTP(S) origin without credentials or path.");
  const variant = publicExercise.variants[language];
  if (!variant) throw new Error("Unsupported exercise language.");
  const commands =
    language === "typescript"
      ? "Install TypeScript 7.0.2 separately, then run:\n\n    tsc --project tsconfig.json\n    node --test public.test.mjs"
      : "Run:\n\n    node --test public.test.mjs";
  const files: Record<string, string> = {
    "README.md": `# ${publicExercise.title}\n\n${publicExercise.description}\n\n## Function\n\n${variant.signature}\n\n## Local checks\n\nRequires Node.js 24.22.1. ${commands}\n\nLocal checks execute your solution on your computer. They use public examples only; Submit also checks additional server cases. No network is needed after installing the toolchain.\n\n${publicExercise.attribution}\n`,
    [variant.filename]: variant.starter,
    "package.json": `${JSON.stringify({ private: true, type: "module", engines: { node: "24.22.1" } }, null, 2)}\n`,
    ".bekor/exercise.json": `${JSON.stringify({ exerciseId: publicExercise.id, exerciseVersion: publicExercise.version, language, runtime: variant.runtime, apiOrigin: origin.origin, permittedFiles: [variant.filename] }, null, 2)}\n`,
    ".bekor/public.json": `${JSON.stringify(publicExercise, null, 2)}\n`,
    "public.test.mjs": `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport { ${variant.entrypoint} as solve } from './solution.js';\nassert.equal(process.version, 'v24.22.1', 'Use the pinned Node.js runtime');\nconst manifest = JSON.parse(readFileSync(new URL('./.bekor/public.json', import.meta.url), 'utf8'));\nconst valid = ${isJsonValue.toString()};\nconst compareJson = ${compareJson.toString()};\nfor (const [index, example] of manifest.variants[${JSON.stringify(language)}].publicTests.entries()) {\n  test('public case ' + (index + 1), async () => {\n    const actual = await solve(...example.args);\n    assert.ok(valid(actual), 'Result must be bounded JSON with safe integers');\n    assert.ok(compareJson(actual, example.expected), 'Result differs from expected output');\n  });\n}\n`,
  };
  if (language === "typescript")
    files["tsconfig.json"] =
      `${JSON.stringify({ compilerOptions: COMPILER_OPTIONS, files: ["solution.ts"], exclude: [] }, null, 2)}\n`;
  return { files };
}
