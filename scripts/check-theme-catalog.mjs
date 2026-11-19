import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const assets = join("dist", "assets");
const files = readdirSync(assets).filter((name) => name.endsWith(".js"));
const catalog = files.filter((name) => name.startsWith("catalog-"));
if (catalog.length !== 1) {
  console.error(`expected one catalog chunk, found ${catalog.length}`);
  process.exit(1);
}

// A token that only the extended Tokyo Night entry carries.
const marker = "#c0caf5";
const catalogText = readFileSync(join(assets, catalog[0]), "utf8");
if (!catalogText.includes(marker)) {
  console.error(`${catalog[0]} does not contain the catalog marker`);
  process.exit(1);
}

const html = readFileSync(join("dist", "index.html"), "utf8");
const entryFiles = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((match) =>
  match[1].replace(/^\//, ""),
);
for (const entry of entryFiles) {
  const text = readFileSync(join("dist", entry), "utf8");
  if (text.includes(marker)) {
    console.error(`${entry} eagerly contains the theme catalog`);
    process.exit(1);
  }
}

console.log(`catalog chunk ${catalog[0]} stays out of ${entryFiles.length} initial scripts`);
