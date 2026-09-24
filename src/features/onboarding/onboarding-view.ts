/**
 * Efxlve Launcher — Authentication & Progressive Loading View.
 *
 * Renders the animated login screen with a 3D tilted game posters marquee,
 * unified input pill, and the progressive console synchronization sequence.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

/** Curated high-res official game posters for the animated 3D background marquee. */
const SHOWCASE_POSTERS: string[] = [
  "https://cdn1.epicgames.com/offer/77f2b98e2cef40c8a74375189e50b446/EGS_Cyberpunk2077_CDPROJEKTRED_S2_1200x1600-b3848b59d57a224f80168d6f30f55737",
  "https://cdn1.epicgames.com/0584dacc38d34984ae4e093ac1f1f397/offer/GTAV_EGS_Artwork_1200x1600_Portrait%20Store%20Display-1200x1600-e7f09315b6320a061a9bc38615024fa8.jpg",
  "https://cdn1.epicgames.com/offer/c4763f236d08423bb47b4a3021be0464/EGS_AlanWake2_RemedyEntertainment_S2_1200x1600-683170632598b965c6c06a38618683ec",
  "https://cdn1.epicgames.com/offer/006095d253234177b966144e057a6221/EGS_DEATHSTRANDINGDIRECTORSCUT_KOJIMAPRODUCTIONS_S2_1200x1600-a292864b4c73043813ff3eb8466b0ca8",
  "https://cdn1.epicgames.com/epic/offer/RDR2PC_1200x1600-1200x1600-e51c8e1a123f8cb123e421e90ef8ab86.jpg",
  "https://cdn1.epicgames.com/offer/e97659b501e64e39b7d7eb0150e645f1/EGS_HogwartsLegacy_AvalancheSoftware_S2_1200x1600-60a6ae56ff6d24a0d92cf0952d7e0d30",
  "https://cdn1.epicgames.com/offer/3ddd6a590da64e3686042d10203a004b/EGS_GodofWar_SantaMonicaStudio_S2_1200x1600-fb50a13346d0a7a3b3a98eb53e9a59cf",
  "https://cdn1.epicgames.com/min/offer/1200x1600-1200x1600-e0da0f2a9694e9f3b7ab4f2c0500a12e.jpg",
  "https://cdn1.epicgames.com/offer/24b99e49a46a4e378c2e646738980862/EGS_Control_RemedyEntertainment_S2_1200x1600-fb7ff76380c557fc99aa9c417e27e849",
  "https://cdn1.epicgames.com/2a9707e4be4249a0b9432655e542d99d/offer/EGS_HorizonZeroDawnCompleteEdition_Guerrilla_S2-1200x1600-098553259837df6d0537025816912389.jpg",
  "https://cdn1.epicgames.com/offer/47b850a490e64a858546b5a3e144a7f0/EGS_Ghostrunner_OneMoreLevel3DRealmsSlipgateIronworks_S2_1200x1600-cf7f0ecba985efaa71ea2315a6bfa9e2",
  "https://cdn1.epicgames.com/offer/581561f384ef46a99268ff9231f868ad/EGS_DeadCells_MotionTwin_S2_1200x1600-a6198f26df8c2fc2b289c8fa7cb137f8",
  "https://cdn1.epicgames.com/offer/401416e0e0a442759e0a05a41bf97f8c/EGS_AssassinsCreedValhalla_UbisoftMontreal_S2_1200x1600-4740263309a632b49877b07044cc1a08",
  "https://cdn1.epicgames.com/offer/14ee004dad8342398941c5baa44141d4/EGS_TheWitcher3WildHuntCompleteEdition_CDPROJEKTRED_S2_1200x1600-53a8242e20f185c7247734293fef61cf",
  "https://cdn1.epicgames.com/offer/4c112ad9463d45b888b5030286430038/EGS_MarvelsSpiderManRemastered_InsomniacGamesNixxesSoftware_S2_1200x1600-756193fe4c2b9a7852f5c767425176b6",
  "https://cdn1.epicgames.com/offer/0c2394cfde5d4e138a0c4f8d55a2979e/EGS_DyingLight2StayHuman_Techland_S2_1200x1600-4eb63e46efc58ef7fb3efc023d515f40",
];

/** Build the HTML for the 3D animated game marquee wall. */
function renderGameMarqueeWall(): string {
  const colSize = 4;
  const cols = [
    SHOWCASE_POSTERS.slice(0, colSize),
    SHOWCASE_POSTERS.slice(colSize, colSize * 2),
    SHOWCASE_POSTERS.slice(colSize * 2, colSize * 3),
    SHOWCASE_POSTERS.slice(colSize * 3, colSize * 4),
  ];

  const colHtml = cols
    .map((posters, idx) => {
      // Duplicate to ensure infinite seamless CSS translation
      const loop = [...posters, ...posters];
      const cards = loop
        .map(
          (url) =>
            `<div class="auth-poster-card"><img class="auth-poster-img" src="${url}" alt="" loading="lazy" /></div>`,
        )
        .join("");
      return `<div class="auth-wall-col auth-col-${idx + 1}">${cards}</div>`;
    })
    .join("");

  return `
    <div class="auth-ambient-backdrop" aria-hidden="true">
      <div class="auth-game-wall">
        ${colHtml}
      </div>
      <div class="auth-vignette-overlay"></div>
      <div class="auth-aurora-blob auth-aurora-1"></div>
      <div class="auth-aurora-blob auth-aurora-2"></div>
    </div>`;
}

/** In-place DOM update for the progressive authentication sequence. */
export function updateAuthProgressUi(): void {
  const bar = document.getElementById("auth-progress-bar");
  const pct = document.getElementById("auth-progress-percent");
  const stage = document.getElementById("auth-stage-text");
  if (bar) bar.style.width = `${S.authProgress}%`;
  if (pct) pct.textContent = `${S.authProgress}%`;
  if (stage) stage.textContent = S.authStageText || "";

  const rows = document.querySelectorAll<HTMLElement>(".auth-step-row");
  if (rows.length >= 4) {
    const p = S.authProgress;
    // Step 0: Auth
    rows[0]?.classList.toggle("done", p >= 40);
    rows[0]?.classList.toggle("active", p < 40);
    // Step 1: Library & Catalog
    rows[1]?.classList.toggle("done", p >= 72);
    rows[1]?.classList.toggle("active", p >= 40 && p < 72);
    // Step 2: Achievements & Trophies
    rows[2]?.classList.toggle("done", p >= 90);
    rows[2]?.classList.toggle("active", p >= 72 && p < 90);
    // Step 3: Ready & Console Launch
    rows[3]?.classList.toggle("done", p >= 100);
    rows[3]?.classList.toggle("active", p >= 90 && p < 100);
  }
}

/** Render the standalone login / progressive loading / setup view. */
export function renderOnboarding(): string {
  const backgroundWall = renderGameMarqueeWall();

  // 1. Initial Legendary binary setup phase (if required)
  if (S.epicPhase === "setup") {
    const pct = S.setupProgress ?? 0;
    return `
      <div class="auth-screen">
        ${backgroundWall}
        <div class="auth-card-wrapper">
          <div class="auth-card auth-setup-card">
            <div class="auth-emblem-halo">${icon("download", 28)}</div>
            <div class="auth-tagline-chip">BAŞLANGIÇ KURULUMU</div>
            <h1 class="auth-title">${t("ob.setupTitle")}</h1>
            <p class="auth-subtitle">${t("ob.setupLead")}</p>
            ${S.epicBusy === "download" ? `
              <div class="auth-progress-track"><div class="auth-progress-bar" style="width:${pct}%"></div></div>
              <p class="auth-loading-stage">${esc(S.setupMessage || t("ob.downloading"))}</p>
            ` : ""}
            <div style="margin-top: 6px;">
              <button class="auth-hero-login-btn" data-act="epic-download" ${S.epicBusy ? "disabled" : ""}>
                ${icon("download", 16)}
                <span>${S.epicBusy ? t("ob.downloading") : t("ob.setupDownload")}</span>
              </button>
            </div>
            <p class="auth-hero-hint">Kaynak: github.com/legendary-gl/legendary (GPL-3.0)</p>
          </div>
        </div>
      </div>`;
  }

  // 2. Cinematic Progressive Loading Sequence
  if (S.authLoading) {
    const p = S.authProgress;
    return `
      <div class="auth-screen">
        ${backgroundWall}
        <div class="auth-card-wrapper">
          <div class="auth-card auth-loading-card">
            <div class="auth-loading-halo">
              <div class="auth-loading-spinner"></div>
              <div class="auth-loading-emblem">
                ${icon("gamepad-2", 30)}
              </div>
            </div>

            <div class="auth-tagline-chip">BAŞLATILIYOR</div>
            <h2 class="auth-loading-title">${t("auth.syncingTitle")}</h2>
            <p class="auth-loading-stage" id="auth-stage-text">${esc(S.authStageText || t("auth.stageAuth"))}</p>

            <div class="auth-progress-track">
              <div class="auth-progress-bar" id="auth-progress-bar" style="width: ${p}%;"></div>
            </div>
            <div class="auth-progress-percent tabular-nums" id="auth-progress-percent">${p}%</div>

            <div class="auth-steps-list">
              <div class="auth-step-row ${p >= 40 ? "done" : "active"}">
                <span class="auth-step-pip">${p >= 40 ? icon("check", 12) : '<span class="auth-step-dot"></span>'}</span>
                <span>${t("auth.stepAuth")}</span>
              </div>
              <div class="auth-step-row ${p >= 72 ? "done" : p >= 40 ? "active" : ""}">
                <span class="auth-step-pip">${p >= 72 ? icon("check", 12) : '<span class="auth-step-dot"></span>'}</span>
                <span>${t("auth.stepCatalog")}</span>
              </div>
              <div class="auth-step-row ${p >= 90 ? "done" : p >= 72 ? "active" : ""}">
                <span class="auth-step-pip">${p >= 90 ? icon("check", 12) : '<span class="auth-step-dot"></span>'}</span>
                <span>${t("auth.stepTrophies")}</span>
              </div>
              <div class="auth-step-row ${p >= 100 ? "done" : p >= 90 ? "active" : ""}">
                <span class="auth-step-pip">${p >= 100 ? icon("check", 12) : '<span class="auth-step-dot"></span>'}</span>
                <span>${t("auth.stepReady")}</span>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  // 3. Cinematic Standalone Console Login View
  return `
    <div class="auth-screen">
      ${backgroundWall}

      <div class="auth-card-wrapper">
        <div class="auth-card">
          <!-- Brand Header -->
          <div class="auth-brand-header">
            <div class="auth-emblem-halo">
              ${icon("gamepad-2", 30)}
            </div>
            <div class="auth-tagline-chip">${t("auth.tagline")}</div>
            <h1 class="auth-title">EFXLVE</h1>
            <p class="auth-subtitle">${t("auth.subtitle")}</p>
          </div>

          <!-- Focused Action Stack -->
          <div class="auth-action-stack">
            <!-- 1. Epic Games Web Sign-in Button -->
            <button class="auth-hero-login-btn" data-act="epic-open-login">
              ${icon("external", 18)}
              <span>${t("auth.epicWebLogin")}</span>
            </button>
            <div class="auth-hero-hint">${t("auth.webHint")}</div>

            <!-- 2. Single Unified Code Pill Input -->
            <div class="auth-input-pill">
              <input
                id="epic-code"
                class="auth-pill-input"
                placeholder="${t("auth.pastePlaceholder")}"
                autocomplete="off"
                spellcheck="false"
              />
              <button class="auth-pill-paste-btn" data-act="auth-paste" title="${t("auth.pasteBtn")}">
                ${icon("copy", 13)}
                <span>${t("auth.pasteBtn")}</span>
              </button>
              <button class="auth-pill-submit-btn" data-act="epic-do-login" title="${t("auth.submitCode")}">
                ${icon("arrow-right", 15)}
              </button>
            </div>

            <!-- 3. Discreet EGL Import Link -->
            <div class="auth-alt-footer">
              <button class="auth-alt-link" data-act="epic-import">
                ${icon("download", 13)}
                <span>${t("auth.importShort")}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}
