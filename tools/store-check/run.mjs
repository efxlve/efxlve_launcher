/**
 * Mağaza doğrulama koşucusu.
 *
 * Üretim paketini (dist/) sahte bir Tauri arka ucuyla tarayıcıda koşturur ve
 * GERÇEK TypeScript mantığını sınar. Statik HTML önizlemelerinden farkı:
 * markup'ı elle taklit etmez, bu yüzden mantık hatalarını (yanlış veri
 * sınıflandırma, yanlış tıklama davranışı, kaydırma konumu vb.) yakalar.
 *
 * Kullanım:
 *   node tools/store-check/run.mjs            # hazırla + tarayıcıda aç (varsa)
 *   node tools/store-check/run.mjs --no-open  # yalnızca hazırla
 *
 * Gereksinimler: Node 18+ (global fetch). Fixture üretimi için Python 3
 * (`gen_fixtures.py`) — yoksa mevcut fixtures.json kullanılır.
 */
import { execFile, execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const noOpen = process.argv.includes("--no-open");

function log(msg) {
  console.log(`[store-check] ${msg}`);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32", ...opts });
}

// ---------------------------------------------------------------- 1) Derleme
// --no-build: dist zaten güncelken derlemeyi atla (hızlı yineleme; ayrıca
// Vite'ın dist'i temizleme adımı bazı ortamlarda silme korumasına takılabiliyor).
const noBuild = process.argv.includes("--no-build");
if (noBuild) {
  log("derleme atlandı (--no-build) — dist mevcut haliyle kullanılacak");
} else {
  log("frontend derleniyor…");
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"]);
}

// ------------------------------------------------- 2) Paket dosyalarını kopyala
const distAssets = join(ROOT, "dist", "assets");
if (!existsSync(distAssets)) {
  console.error("[store-check] dist/assets bulunamadı — derleme başarısız olmuş olabilir.");
  process.exit(1);
}
// ------------------------------------------- 3) HTML'deki asset adlarını eşitle
// Vite her derlemede yeni hash üretir; harness sabit yol kullanır.
const distFiles = readdirSync(distAssets);
const js = distFiles.find((f) => f.endsWith(".js"));
const css = distFiles.find((f) => f.endsWith(".css"));
if (!js || !css) {
  console.error("[store-check] derleme çıktısında .js/.css bulunamadı");
  process.exit(1);
}

// Hash'li adlar yerine SABİT adlarla kopyala: hiçbir zaman silme gerekmez
// (toplu silme korumalarına takılmaz) ve eski dosya birikmez.
const targetAssets = join(HERE, "assets");
mkdirSync(targetAssets, { recursive: true });
cpSync(join(distAssets, js), join(targetAssets, "app.js"));
cpSync(join(distAssets, css), join(targetAssets, "app.css"));

const htmlPath = join(HERE, "index.html");
let html = readFileSync(htmlPath, "utf8");
html = html
  .replace(/\/assets\/[^"']+\.js/g, "/assets/app.js")
  .replace(/\/assets\/[^"']+\.css/g, "/assets/app.css");
writeFileSync(htmlPath, html);
log(`asset eşlendi: ${js} → assets/app.js, ${css} → assets/app.css`);

// --------------------------------------------------------- 4) Fixture üretimi
const py = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
try {
  execSync(`${py} "${join(HERE, "gen_fixtures.py")}"`, { cwd: ROOT, stdio: "inherit" });
} catch {
  if (existsSync(join(HERE, "fixtures.js"))) {
    log("UYARI: Python ile fixture üretilemedi; mevcut fixtures.js kullanılacak (veri eski olabilir).");
  } else {
    console.error("[store-check] fixture üretilemedi ve mevcut fixtures.js yok. Python 3 gerekir.");
    process.exit(1);
  }
}

// ------------------------------------------------- 5) Otomatik kontrol (CI)
/** Chrome yolunu bulur; bulunamazsa null. */
function findChrome() {
  return [
    process.env.CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((c) => c && existsSync(c));
}

/** Sayfayı headless çalıştırıp doğrulama panelini metne çevirir. */
async function runMode(chrome, baseUrl, mode) {
  const url = mode ? `${baseUrl}?mode=${mode}` : baseUrl;
  const tmpProfile = join(resolve(HERE, ".tmp-chrome-profile-" + (mode || "default") + "-" + Date.now()));
  mkdirSync(tmpProfile, { recursive: true });
  const dom = await new Promise((resolve, reject) => {
    execFile(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--disable-background-networking",
        "--incognito",
        `--user-data-dir=${tmpProfile}`,
        "--virtual-time-budget=60000",
        "--dump-dom",
        url,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], timeout: 120000 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
  const panel = dom.match(/id="verify-panel"[^>]*>([\s\S]*?)(?:<\/div>\s*<script|$)/);
  const body = panel ? panel[1] : "";
  const rows = [...body.matchAll(/<div class="([^"]*)">([\s\S]*?)<\/div>/g)];
  const results = rows.map((r) => ({
    kind: r[1],
    text: r[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim(),
  }));
  return results.filter((r) => r.text);
}

if (process.argv.includes("--check")) {
  const chrome = findChrome();
  if (!chrome) {
    console.error("[store-check] Chrome bulunamadı — --check için gerekli (CHROME env ile yol verilebilir).");
    process.exit(2);
  }
  const port = Number(process.env.PORT || 8790);
  const server = createServer((req, res) => {
    try {
      const urlPath = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`).pathname;
      const cleanPath = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      const filePath = resolve(HERE, cleanPath);
      if (!filePath.startsWith(HERE) || !existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = filePath.split(".").pop();
      const types = {
        html: "text/html; charset=utf-8",
        js: "application/javascript; charset=utf-8",
        css: "text/css; charset=utf-8",
        json: "application/json; charset=utf-8",
        png: "image/png",
        jpg: "image/jpeg",
        svg: "image/svg+xml",
      };
      res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
      res.end(readFileSync(filePath));
    } catch {
      res.writeHead(500);
      res.end("Server error");
    }
  });

  await new Promise((r) => server.listen(port, "127.0.0.1", r));

  let totalFail = 0;
  try {
    for (const mode of ["", "empty", "fail", "edge"]) {
      const label = mode || "default";
      const rows = await runMode(chrome, `http://127.0.0.1:${port}/index.html`, mode);
      const fails = rows.filter((r) => r.kind === "bad");
      const passes = rows.filter((r) => r.kind === "ok" && r.text.startsWith("PASS")).length;
      totalFail += fails.length;
      console.log(`\n── mod: ${label} — PASS=${passes} FAIL=${fails.length}`);
      for (const f of fails) console.log(`   FAIL > ${f.text}`);
    }
  } finally {
    server.close();
  }
  console.log(totalFail === 0 ? "\nMağaza doğrulaması: TÜMÜ GEÇTİ" : `\nMağaza doğrulaması: ${totalFail} BAŞARISIZ`);
  process.exit(totalFail === 0 ? 0 : 1);
}

// ------------------------------------------------------------- 6) Kullanım
const port = Number(process.env.PORT || 8790);
const url = `http://127.0.0.1:${port}/index.html`;

log("");
log("Otomatik kontrol (önerilen):  node tools/store-check/run.mjs --check");
log("");
log("Elle incelemek için iki adım:");
log(`  1)  cd tools/store-check && ${py} -m http.server ${port}`);
log(`  2)  tarayıcıda aç:  ${url}`);
log("");
log("Sonuçlar sayfanın sağ alt köşesindeki panelde listelenir; kırmızı FAIL satırı hata demektir.");
log("Tarayıcı elle açılıyorsa konsolu da kontrol et — harness JS hatalarını panele yazar.");

// Ekran görüntüsü almak isteyenler için hazır komut (Chrome yolu platforma göre değişir)
const chromeCandidates = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
];
const chrome = chromeCandidates.find((c) => existsSync(c));
if (chrome) {
  log("");
  log("Ekran görüntüsü (CI/otomatik kontrol için):");
  log(
    `  "${chrome}" --headless=new --disable-gpu --hide-scrollbars ` +
      `--virtual-time-budget=50000 --window-size=1000,1500 ` +
      `--screenshot="${join(HERE, "report.png")}" ${url}`,
  );
}
if (noOpen) log("(--no-open verildi; yalnızca hazırlık yapıldı)");
