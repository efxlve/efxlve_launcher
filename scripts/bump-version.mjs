// Version bump for a release. Node writes UTF-8 without a BOM on purpose:
// PowerShell's `Set-Content -Encoding UTF8` adds one, and Tauri's config parser
// then fails with "expected value at line 1 column 1" (that cost us a release).
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/bump-version.mjs <version>");
  process.exit(1);
}

const targets = [
  ["package.json", /"version": "[^"]+"/, `"version": "${version}"`],
  ["src-tauri/tauri.conf.json", /"version": "[^"]+"/, `"version": "${version}"`],
  ["src-tauri/Cargo.toml", /^version = "[^"]+"/m, `version = "${version}"`],
];

for (const [file, pattern, replacement] of targets) {
  const text = readFileSync(file, "utf8");
  if (!pattern.test(text)) {
    console.error(`no version field found in ${file}`);
    process.exit(1);
  }
  writeFileSync(file, text.replace(pattern, replacement), "utf8");
  console.log(`${file} -> ${version}`);
}
