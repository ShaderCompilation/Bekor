import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import {
  type Language,
  MAX_CASES,
  MAX_SOURCE_BYTES,
  type PublicExercise,
  publicExerciseSchema,
  testCaseSchema,
} from "@bekor/contracts";
import { z } from "zod";
import { createPublicDownload } from "./public.js";

const plainMarkdown = (value: string) =>
  !/[<>]|!\[|\]\s*\(|(?:javascript|data|vbscript)\s*:/i.test(value);
export const authoredExerciseSchema = z
  .object({
    public: publicExerciseSchema,
    privateTests: z.array(testCaseSchema).min(1).max(MAX_CASES),
    referenceSolutions: z
      .object({
        javascript: z.string().min(1).max(MAX_SOURCE_BYTES),
        typescript: z.string().min(1).max(MAX_SOURCE_BYTES),
      })
      .strict(),
    explanation: z.string().min(1).max(20_000),
  })
  .strict()
  .superRefine((exercise, ctx) => {
    for (const language of ["javascript", "typescript"] as const) {
      const variant = exercise.public.variants[language];
      if (
        variant.language !== language ||
        variant.filename !== (language === "javascript" ? "solution.js" : "solution.ts")
      )
        ctx.addIssue({ code: "custom", message: "Variant language and filename mismatch" });
      if (variant.publicTests.length + exercise.privateTests.length > MAX_CASES)
        ctx.addIssue({ code: "custom", message: "Total case budget exceeded" });
      if (
        Buffer.byteLength(variant.starter) > MAX_SOURCE_BYTES ||
        Buffer.byteLength(exercise.referenceSolutions[language]) > MAX_SOURCE_BYTES
      )
        ctx.addIssue({ code: "custom", message: "Source byte budget exceeded" });
      for (const testCase of [...variant.publicTests, ...exercise.privateTests]) {
        if (
          Buffer.byteLength(JSON.stringify(testCase.args)) > 32_768 ||
          Buffer.byteLength(JSON.stringify(testCase.expected)) + 64 > variant.limits.outputBytes
        )
          ctx.addIssue({
            code: "custom",
            message: "Test data exceeds execution input/output budget",
          });
      }
    }
    const { javascript, typescript } = exercise.public.variants;
    if (
      javascript.entrypoint !== typescript.entrypoint ||
      JSON.stringify(javascript.publicTests) !== JSON.stringify(typescript.publicTests)
    )
      ctx.addIssue({
        code: "custom",
        message: "Language variants must share function and test semantics",
      });
    for (const text of [
      exercise.public.title,
      exercise.public.description,
      exercise.public.attribution,
      ...exercise.public.hints,
      exercise.explanation,
    ])
      if (!plainMarkdown(text))
        ctx.addIssue({
          code: "custom",
          message: "Authored prose permits plain Markdown only; no HTML, images or links",
        });
  });
export type AuthoredExercise = z.infer<typeof authoredExerciseSchema>;

const directory = new URL("../../../content/exercises/", import.meta.url);
let catalog: AuthoredExercise[] | undefined;
function loadCatalog(): AuthoredExercise[] {
  if (!catalog) {
    const loaded = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) =>
        authoredExerciseSchema.parse(JSON.parse(readFileSync(new URL(name, directory), "utf8"))),
      );
    const identities = new Set<string>(),
      slugs = new Map<string, string>();
    for (const item of loaded) {
      const identity = `${item.public.id}@${item.public.version}`;
      if (identities.has(identity)) throw new Error(`Duplicate exercise version: ${identity}`);
      if (slugs.has(item.public.slug) && slugs.get(item.public.slug) !== item.public.id)
        throw new Error("Exercise slug collision");
      identities.add(identity);
      slugs.set(item.public.slug, item.public.id);
    }
    catalog = loaded;
  }
  return catalog;
}
// Copies prevent consumers from mutating the trusted published definition in memory.
export function listExercises(): AuthoredExercise[] {
  return structuredClone(loadCatalog());
}
export function getExercise(id: string, version: string): AuthoredExercise | undefined {
  const item = loadCatalog().find(
    (entry) => entry.public.id === id && entry.public.version === version,
  );
  return item && structuredClone(item);
}
export function getExerciseBySlug(slug: string, version?: string): AuthoredExercise | undefined {
  const matches = loadCatalog().filter(
    (entry) =>
      entry.public.slug === slug && (version === undefined || entry.public.version === version),
  );
  // Default selection belongs to persisted publication state once multiple versions exist.
  if (version === undefined && matches.length > 1)
    throw new Error("An explicit version is required for a multi-version exercise.");
  return matches[0] && structuredClone(matches[0]);
}
export function toPublicExercise(authored: AuthoredExercise): PublicExercise {
  const p = authored.public;
  const variant = (language: Language) => {
    const v = p.variants[language];
    return {
      language: v.language,
      runtime: v.runtime,
      filename: v.filename,
      entrypoint: v.entrypoint,
      signature: v.signature,
      starter: v.starter,
      publicTests: v.publicTests,
      limits: v.limits,
    };
  };
  return publicExerciseSchema.parse({
    id: p.id,
    slug: p.slug,
    version: p.version,
    title: p.title,
    description: p.description,
    difficulty: p.difficulty,
    concepts: p.concepts,
    hints: p.hints,
    attribution: p.attribution,
    variants: { javascript: variant("javascript"), typescript: variant("typescript") },
  });
}
export function createDownload(authored: AuthoredExercise, language: Language, apiOrigin: string) {
  return createPublicDownload(toPublicExercise(authored), language, apiOrigin);
}
export function contentHash(authored: AuthoredExercise): string {
  return createHash("sha256")
    .update(JSON.stringify(authoredExerciseSchema.parse(authored)))
    .digest("hex");
}
