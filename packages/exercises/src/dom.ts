import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import {
  type DomExercise,
  domExerciseSchema,
  domFilesSchema,
  type Framework,
  type Language,
} from "@bekor/contracts";
import { z } from "zod";

export const authoredDomExerciseSchema = z
  .object({
    public: domExerciseSchema,
    referenceSolutions: z.record(z.string(), domFilesSchema),
    explanation: z.string().min(1).max(20_000),
  })
  .strict()
  .superRefine((exercise, ctx) => {
    for (const text of [
      exercise.public.title,
      exercise.public.description,
      exercise.public.attribution,
      ...exercise.public.hints,
      ...exercise.public.checklist,
      exercise.explanation,
    ])
      if (/[<>]|!\[|\]\s*\(|(?:javascript|data|vbscript)\s*:/i.test(text))
        ctx.addIssue({ code: "custom", message: "DOM prose allows plain Markdown only" });
    const ids = exercise.public.variants.map((v) => v.id);
    if (Object.keys(exercise.referenceSolutions).some((id) => !ids.includes(id)))
      ctx.addIssue({ code: "custom", message: "Unknown reference variant" });
    for (const variant of exercise.public.variants) {
      const reference = exercise.referenceSolutions[variant.id];
      if (
        !reference ||
        JSON.stringify(Object.keys(reference).sort()) !==
          JSON.stringify(Object.keys(variant.files).sort())
      )
        ctx.addIssue({ code: "custom", message: "Reference must match editable paths" });
      // This release has a fixed, audited framework dependency allowlist.
      const allowed: Record<Framework, string[]> = {
        vanilla: [],
        react: ["react", "react-dom"],
        vue: ["vue", "@vue/cli-plugin-babel", "@vue/cli-service"],
        svelte: ["svelte"],
      };
      if (
        Object.keys(variant.dependencies).some((name) => !allowed[variant.framework].includes(name))
      )
        ctx.addIssue({ code: "custom", message: "Dependency is outside framework allowlist" });
    }
  });
export type AuthoredDomExercise = z.infer<typeof authoredDomExerciseSchema>;
const directory = new URL("../../../content/dom/", import.meta.url);
let catalog: AuthoredDomExercise[] | undefined;
export function listDomExercises(): AuthoredDomExercise[] {
  catalog ??= readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) =>
      authoredDomExerciseSchema.parse(JSON.parse(readFileSync(new URL(name, directory), "utf8"))),
    );
  const identities = catalog.map((item) => `${item.public.id}@${item.public.version}`);
  if (new Set(identities).size !== identities.length) throw new Error("Duplicate DOM version");
  return structuredClone(catalog);
}
export function getDomExercise(id: string, version: string) {
  return listDomExercises().find(
    (item) => item.public.id === id && item.public.version === version,
  );
}
export function domContentHash(exercise: AuthoredDomExercise) {
  return createHash("sha256")
    .update(JSON.stringify(authoredDomExerciseSchema.parse(exercise)))
    .digest("hex");
}
export function toPublicDomExercise(exercise: AuthoredDomExercise): DomExercise {
  return domExerciseSchema.parse(exercise.public);
}
export function createDomDownload(
  exercise: AuthoredDomExercise,
  framework: Framework,
  language: Language,
  apiOrigin: string,
) {
  const origin = new URL(apiOrigin);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Expected an HTTP(S) API origin");
  const variant = exercise.public.variants.find(
    (v) => v.framework === framework && v.language === language,
  );
  if (!variant) throw new Error("Unsupported DOM variant");
  return {
    files: {
      ...variant.files,
      "README.md": `${exercise.public.title}\n\n${exercise.public.description}\n\nManual checklist\n${exercise.public.checklist.map((item) => `- ${item}`).join("\n")}\n\nSelf-assessed exercise. No automatic tests or bekor submit. Use the Bekor browser preview to edit these files, or create a local static project for ${framework} with the exact dependencies in .bekor/exercise.json. Downloads never install or run code. Explicit completion uses the same practice-session API as the browser.\n`,
      ".bekor/exercise.json": JSON.stringify(
        {
          exerciseId: exercise.public.id,
          exerciseVersion: exercise.public.version,
          kind: "dom",
          assessment: "self",
          runtime: "browser",
          apiOrigin,
          variantId: variant.id,
          framework,
          language,
          entry: variant.entry,
          files: Object.keys(variant.files),
          dependencies: variant.dependencies,
          compilerVersion: variant.compilerVersion,
        },
        null,
        2,
      ),
    },
  };
}
