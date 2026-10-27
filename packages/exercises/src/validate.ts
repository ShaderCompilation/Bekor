import { createDownload, listExercises } from "./index.js";

const exercises = listExercises();
if (exercises.length < 3) throw new Error("The first slice requires three original exercises.");
for (const exercise of exercises)
  for (const language of ["javascript", "typescript"] as const)
    createDownload(exercise, language, "https://bekor.example");
console.log(
  `Validated ${exercises.length} authored exercises and ${exercises.length * 2} public bundles. No learner code executed.`,
);
