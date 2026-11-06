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
  ["README.md", /version-\d+\.\d+\.\d+-222/, `version-${version}-222`],
  ["README.md", /alt="Version \d+\.\d+\.\d+"/, `alt="Version ${version}"`],
  ["README.md", /\*\*v\d+\.\d+\.\d+\*\*/, `**v${version}**`],
  // The link text and the href both carry the tag.
  ["README.md", /releases\/tag\/v\d+\.\d+\.\d+/g, `releases/tag/v${version}`],
  // The download table names the actual bundle files; keep every row on the release.
  ["README.md", /Efxlve\.Launcher_\d+\.\d+\.\d+_x64-setup\.exe/, `Efxlve.Launcher_${version}_x64-setup.exe`],
  ["README.md", /Efxlve\.Launcher_\d+\.\d+\.\d+_x64_en-US\.msi/, `Efxlve.Launcher_${version}_x64_en-US.msi`],
  ["README.md", /Efxlve\.Launcher_\d+\.\d+\.\d+_amd64\.AppImage/, `Efxlve.Launcher_${version}_amd64.AppImage`],
  ["README.md", /Efxlve\.Launcher_\d+\.\d+\.\d+_amd64\.deb/, `Efxlve.Launcher_${version}_amd64.deb`],
  ["README.md", /Efxlve\.Launcher-\d+\.\d+\.\d+-1\.x86_64\.rpm/, `Efxlve.Launcher-${version}-1.x86_64.rpm`],
  ["README.md", /Efxlve\.Launcher_\d+\.\d+\.\d+_aarch64\.dmg/, `Efxlve.Launcher_${version}_aarch64.dmg`],
  // The winbar shows this until `getVersion()` answers, and the browser preview
  // never gets an answer, so both literals follow the release.
  ["src/core/state.ts", /appVersion: "\d+\.\d+\.\d+"/, `appVersion: "${version}"`],
  ["index.html", /winbar-version-num">v\d+\.\d+\.\d+</, `winbar-version-num">v${version}<`],
];

for (const [file, pattern, replacement] of targets) {
  const text = readFileSync(file, "utf8");
  if (!pattern.test(text)) {
    console.error(`no version field found in ${file}`);
    process.exit(1);
  }
  // Every matching occurrence must move together: a README row that keeps an
  // old file name is a broken download link.
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const global = new RegExp(pattern.source, flags);
  writeFileSync(file, text.replace(global, replacement), "utf8");
  console.log(`${file} -> ${version}`);
}
