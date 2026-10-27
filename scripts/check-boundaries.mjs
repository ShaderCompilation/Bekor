import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const violations = [];
function scan(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) scan(path);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      const source = readFileSync(path, "utf8");
      const publicPackage = /^(apps\/(web|cli)|packages\/(contracts|api-client))\//.test(
        relative(".", path),
      );
      if (
        publicPackage &&
        /(?:@bekor\/(?:db|core|runner|scheduling)|@bekor\/exercises(?!\/public)|content\/exercises)/.test(
          source,
        )
      ) {
        violations.push(path);
      }
    }
  }
}
scan("apps");
scan("packages");
if (violations.length) {
  throw new Error(`Forbidden server import in public package: ${violations.join(", ")}`);
}
console.log("Package boundary checks passed.");
