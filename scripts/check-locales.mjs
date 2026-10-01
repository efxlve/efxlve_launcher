import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join("src", "locales");
const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
const read = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const enKeys = Object.keys(read("en.json"));
const enSet = new Set(enKeys);
let failed = false;

for (const name of files) {
  const keys = Object.keys(read(name));
  const set = new Set(keys);
  const missing = enKeys.filter((key) => !set.has(key));
  const extra = keys.filter((key) => !enSet.has(key));
  if (missing.length || extra.length) {
    failed = true;
    console.error(name);
    if (missing.length) console.error("  missing:", missing.join(", "));
    if (extra.length) console.error("  extra:", extra.join(", "));
  }
}

if (failed) process.exit(1);
console.log(`${files.length} locale files, ${enKeys.length} keys, all matched`);
