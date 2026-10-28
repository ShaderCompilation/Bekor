import {
  domExerciseSchema,
  domFilesSchema,
  domVariantSchema,
  exerciseDetailSchema,
  isDomExercise,
  MAX_SOURCE_BYTES,
  publicExerciseSchema,
} from "@bekor/contracts";
import { describe, expect, it } from "vitest";
import {
  authoredDomExerciseSchema,
  createDomDownload,
  domContentHash,
  getDomExercise,
  listDomExercises,
  toPublicDomExercise,
} from "../src/dom.js";
import { getExercise, toPublicExercise } from "../src/index.js";

const accordion = () => getDomExercise("accessible-accordion", "1.0.0")!;

describe("self-assessed DOM exercise publication", () => {
  it("publishes one original exercise with four fixed JavaScript variants and isolated copies", () => {
    const authored = accordion();
    expect(listDomExercises()).toHaveLength(1);
    expect(authoredDomExerciseSchema.safeParse(authored).success).toBe(true);
    expect(authored.public.variants.map((variant) => variant.id)).toEqual([
      "vanilla-javascript",
      "react-javascript",
      "vue-javascript",
      "svelte-javascript",
    ]);
    expect(authored.public.variants.every((variant) => variant.language === "javascript")).toBe(
      true,
    );
    expect(authored.public.checklist.length).toBeGreaterThanOrEqual(5);
    expect(getDomExercise(authored.public.id, "unknown")).toBeUndefined();
    const hash = domContentHash(authored);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    authored.public.title = "Local mutation";
    authored.public.variants[0]!.files["index.js"] = "Local mutation";
    expect(domContentHash(accordion())).toBe(hash);
  });

  it("keeps legacy Node detail and browser detail distinguishable without rewriting Node content", () => {
    const node = toPublicExercise(getExercise("cumulative-sums", "1.0.0")!);
    const dom = toPublicDomExercise(accordion());
    expect(publicExerciseSchema.parse(node)).toEqual(node);
    expect(exerciseDetailSchema.parse(node)).toEqual(node);
    expect(isDomExercise(node)).toBe(false);
    expect(domExerciseSchema.parse(dom)).toEqual(dom);
    expect(exerciseDetailSchema.parse(dom)).toEqual(dom);
    expect(isDomExercise(dom)).toBe(true);
    expect(publicExerciseSchema.safeParse(dom).success).toBe(false);
    expect(domExerciseSchema.safeParse(node).success).toBe(false);
    expect(Object.hasOwn(node, "kind")).toBe(false);
  });

  it("downloads exactly the selected starter files and manual metadata without reference solutions", () => {
    const authored = accordion();
    const publicExercise = toPublicDomExercise(authored);
    expect(Object.hasOwn(publicExercise, "referenceSolutions")).toBe(false);
    expect(Object.hasOwn(publicExercise, "explanation")).toBe(false);
    for (const variant of authored.public.variants) {
      const bundle = createDomDownload(
        authored,
        variant.framework,
        variant.language,
        "https://bekor.example",
      );
      expect(Object.keys(bundle.files).sort()).toEqual(
        [...Object.keys(variant.files), "README.md", ".bekor/exercise.json"].sort(),
      );
      for (const [path, starter] of Object.entries(variant.files))
        expect(bundle.files[path]).toBe(starter);
      expect(JSON.parse(bundle.files[".bekor/exercise.json"]!)).toMatchObject({
        exerciseId: authored.public.id,
        exerciseVersion: authored.public.version,
        variantId: variant.id,
        framework: variant.framework,
        language: variant.language,
        entry: variant.entry,
        files: Object.keys(variant.files),
        dependencies: variant.dependencies,
        assessment: "self",
        runtime: "browser",
      });
      const packed = JSON.stringify(bundle);
      expect(packed).not.toContain("referenceSolutions");
      expect(packed).not.toContain("privateTests");
      expect(packed).not.toContain(JSON.stringify(authored.explanation));
      for (const [path, source] of Object.entries(authored.referenceSolutions[variant.id]!)) {
        if (source !== variant.files[path]) expect(packed).not.toContain(JSON.stringify(source));
      }
      expect(
        createDomDownload(authored, variant.framework, variant.language, "https://bekor.example"),
      ).toEqual(bundle);
    }
    expect(() =>
      createDomDownload(authored, "react", "typescript", "https://bekor.example"),
    ).toThrow("Unsupported DOM variant");
  });

  it("rejects unsafe paths, unpinned dependencies, oversized projects and inconsistent variants", () => {
    for (const path of [
      "../escape.js",
      "/index.js",
      "src/index.js",
      "package.json",
      "index.js?x",
      "constructor",
    ])
      expect(domFilesSchema.safeParse({ [path]: "" }).success, path).toBe(false);
    expect(domFilesSchema.safeParse({}).success).toBe(false);
    expect(
      domFilesSchema.safeParse(
        Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`file${index}.js`, ""])),
      ).success,
    ).toBe(false);
    expect(domFilesSchema.safeParse({ "a.js": "é".repeat(MAX_SOURCE_BYTES / 2 + 1) }).success).toBe(
      false,
    );
    const variant = accordion().public.variants.find((item) => item.framework === "react")!;
    for (const version of ["latest", "^18.3.1", "~18.3.1", "18", "https://example.test/pkg"])
      expect(
        domVariantSchema.safeParse({ ...variant, dependencies: { react: version } }).success,
      ).toBe(false);
    expect(
      domVariantSchema.safeParse({
        ...variant,
        dependencies: { ...variant.dependencies, react: "18.2.0" },
      }).success,
    ).toBe(false);
    expect(domVariantSchema.safeParse({ ...variant, dependencies: {} }).success).toBe(false);
    expect(
      domVariantSchema.safeParse({ ...variant, compilerVersion: "sandpack-0.0.0" }).success,
    ).toBe(false);
    expect(domVariantSchema.safeParse({ ...variant, entry: "missing.js" }).success).toBe(false);
    expect(domVariantSchema.safeParse({ ...variant, id: "vue-javascript" }).success).toBe(false);
    const duplicate = accordion();
    duplicate.public.variants.push(structuredClone(duplicate.public.variants[0]!));
    expect(authoredDomExerciseSchema.safeParse(duplicate).success).toBe(false);
    const extraDependency = accordion();
    extraDependency.public.variants[0]!.dependencies = { "unapproved-package": "1.0.0" };
    expect(authoredDomExerciseSchema.safeParse(extraDependency).success).toBe(false);
    const missingReference = accordion();
    delete missingReference.referenceSolutions["react-javascript"];
    expect(authoredDomExerciseSchema.safeParse(missingReference).success).toBe(false);
    const extraReference = accordion();
    extraReference.referenceSolutions["react-javascript"]!["extra.js"] = "";
    expect(authoredDomExerciseSchema.safeParse(extraReference).success).toBe(false);
    const unknownReference = accordion();
    unknownReference.referenceSolutions["angular-javascript"] = { "index.js": "" };
    expect(authoredDomExerciseSchema.safeParse(unknownReference).success).toBe(false);
  });
});
