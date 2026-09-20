/* eslint-disable */
// Üst bar tasarım önizlemesi üretici — gerçek src/styles.css + index.html'den beslenir.
// Kullanım: node tools/ui-preview/titlebar-preview.mjs
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dir = path.join(process.env.TEMP || "", "efx-nav-preview");
fs.mkdirSync(dir, { recursive: true });

const css = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
const rootBlock = (css.match(/:root \{[\s\S]*?\n\}/) || [""])[0];
const start = css.indexOf("/* --- Titlebar");
const end = css.indexOf("/* --- Content ---");
if (start < 0 || end < 0) throw new Error("titlebar siniri bulunamadi");
const block = css.slice(start, end);

const sw = 'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const icons = {
  store: `<svg ${sw}><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/></svg>`,
  "layout-grid": `<svg ${sw}><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>`,
  download: `<svg ${sw}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>`,
  "gamepad-2": `<svg ${sw}><line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/></svg>`,
  settings: `<svg ${sw}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
};

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
let bar = (html.match(/<header id="titlebar"[\s\S]*?<\/header>/) || [""])[0];
bar = bar.replace(/<i data-lucide="([a-z0-9-]+)"><\/i>/g, (m, n) => icons[n] || "");
bar = bar
  .replace('class="account-chip"', 'class="account-chip logged"')
  .replace(/<span class="account-avatar">[\s\S]*?<\/span>/, '<span class="account-avatar"><span class="avatar-initial">E</span></span>')
  .replace("Giriş yapılmadı", "Efxlve")
  .replace('<span id="dl-badge" class="badge hidden"></span>', '<span id="dl-badge" class="badge">2</span>');

// Uygulamadaki NAV_AMBIENT haritasının birebir kopyası (src/main.ts ile senkron tutulur)
const NAV_AMBIENT = {
  store: "rgba(56, 132, 255, 0.13)",
  library: "rgba(124, 108, 232, 0.20)",
  downloads: "rgba(0, 178, 158, 0.13)",
  profile: "rgba(206, 152, 48, 0.13)",
};

// Her bölüm için ayrı önizleme sayfası üret (aktif sekme + ortam ışığı)
const views = ["store", "library", "downloads"];
for (const v of views) {
  let b = bar;
  if (v !== "library") {
    b = b.replace('class="nav-tab active" data-view="library"', 'class="nav-tab" data-view="library"');
    b = b.replace(
      v === "store" ? 'class="nav-tab" data-act="open-store"' : 'class="nav-tab" data-view="downloads"',
      v === "store" ? 'class="nav-tab active" data-act="open-store"' : 'class="nav-tab active" data-view="downloads"'
    );
  }
  const page = [
    '<!doctype html><html lang="tr"><head><meta charset="utf-8"><style>',
    rootBlock, "\n", block,
    '\nhtml,body{margin:0;background:#0b0c10;font-family:"Segoe UI",system-ui,sans-serif;height:100vh;overflow:hidden}',
    '#app{display:flex;flex-direction:column;height:100vh}',
    '#content{flex:1;background:linear-gradient(180deg,#0b0c10,#0d0e14)}',
    '*{transition:none !important;animation:none !important}',
    `#titlebar{--nav-ambient:${NAV_AMBIENT[v]}}`,
    '</style></head><body><div id="app">', b, '<main id="content"></main></div>',
    '<scr' + 'ipt>',
    "function place(){const bar=document.getElementById('titlebar');const seg=document.getElementById('nav-seg');const ind=document.getElementById('nav-indicator');if(!bar||!seg||!ind)return;const active=seg.querySelector('.nav-tab.active');if(!active){ind.style.opacity='0';return}const b=bar.getBoundingClientRect();const t=active.getBoundingClientRect();ind.style.width=t.width+'px';ind.style.transform='translateX('+(t.left-b.left)+'px)';ind.style.opacity='1'}",
    'function loop(n){place();if(n>0)requestAnimationFrame(function(){loop(n-1)})}',
    "window.addEventListener('resize',function(){loop(12)});document.fonts.ready.then(function(){loop(12)});loop(12);",
    '</scr' + 'ipt></body></html>',
  ].join("");
  fs.writeFileSync(path.join(dir, `preview-${v}.html`), page);
}
console.log("OK " + dir);
