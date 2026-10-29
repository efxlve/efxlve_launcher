import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join("src", "locales");
const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
const read = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const enKeys = Object.keys(read("en.json"));
const enSet = new Set(enKeys);
let failed = false;

// A "?" glued to a letter, or two in a row, is a non-ASCII character that a
// lossy edit replaced. URLs are skipped: "?a=1" is a query string, not a
// mangled letter.
const mangled = (text) =>
  /[\uFFFD]|\?\?|\p{L}\?\p{L}|\?\p{L}/u.test(text.replace(/https?:\/\/\S+/g, ""));

for (const name of files) {
  const locale = read(name);
  const keys = Object.keys(locale);
  const set = new Set(keys);
  const missing = enKeys.filter((key) => !set.has(key));
  const extra = keys.filter((key) => !enSet.has(key));
  if (missing.length || extra.length) {
    failed = true;
    console.error(name);
    if (missing.length) console.error("  missing:", missing.join(", "));
    if (extra.length) console.error("  extra:", extra.join(", "));
  }
  const broken = Object.entries(locale)
    .filter(([, value]) => typeof value === "string" && mangled(value))
    .map(([key]) => key);
  if (broken.length) {
    failed = true;
    console.error(name);
    console.error("  mangled characters:", broken.join(", "));
  }
}

if (failed) process.exit(1);
console.log(`${files.length} locale files, ${enKeys.length} keys, all matched`);
