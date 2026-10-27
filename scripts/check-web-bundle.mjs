// Fails if the built web app contains server-only exercise content: reference solutions,
// explanations or private test data. Run after `pnpm --filter @bekor/web build`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dist = "apps/web/dist";
if (!existsSync(dist)) throw new Error(`${dist} not found; build the web app first.`);
const files = [];
(function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else files.push(path);
  }
})(dist);
const bundle = files.map((path) => readFileSync(path, "utf8")).join("\n");

const leaks = [];
for (const name of readdirSync("content/exercises")) {
  if (!name.endsWith(".json")) continue;
  const exercise = JSON.parse(readFileSync(join("content/exercises", name), "utf8"));
  const secrets = [
    exercise.explanation,
    ...Object.values(exercise.referenceSolutions ?? {}),
    ...(exercise.privateTests ?? []).map((test) => JSON.stringify(test.args)),
  ];
  for (const secret of secrets) {
    // Short fragments could match by coincidence; every check uses distinctive content.
    if (typeof secret === "string" && secret.length >= 12 && bundle.includes(secret))
      leaks.push(`${name}: ${secret.slice(0, 40)}…`);
  }
}
if (leaks.length) throw new Error(`Server-only content found in ${dist}:\n${leaks.join("\n")}`);
console.log(`Web bundle check passed (${files.length} files, no server-only content).`);
