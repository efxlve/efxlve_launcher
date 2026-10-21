import { icon } from "../../core/icons";
import { customGameRoot } from "../../core/dom";
import { S } from "../../core/state";
import { t } from "../../i18n";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import { render } from "../../core/render";
import {
  customGamesAdd,
  customGamesEdit,
  customGamesPickFile,
  customGamesSearchSteam,
  customGamesSteamDetails,
  type SteamStoreSearchHit,
} from "../../custom-games";
import { loadCustomGamesLibrary } from "./custom-games-library";

let searchTimeout: ReturnType<typeof setTimeout> | null = null;
let currentHits: SteamStoreSearchHit[] = [];

export function openAddCustomGameModal(): void {
  S.isAddCustomGameOpen = true;
  renderCustomGameModal();
}

export function closeAddCustomGameModal(): void {
  S.isAddCustomGameOpen = false;
  currentHits = [];
  const root = customGameRoot;
  const el = root?.querySelector(".custom-game-backdrop");
  if (el) el.remove();
}

export function renderCustomGameModal(): void {
  const root = customGameRoot;
  if (!root) return;
  let backdrop = root.querySelector<HTMLElement>(".custom-game-backdrop");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop custom-game-backdrop";
    backdrop.dataset.act = "close-custom-game-modal";
    root.appendChild(backdrop);
  }

  backdrop.innerHTML = `
    <div class="modal custom-game-modal" data-act="prevent-modal-close">
      <div class="custom-game-head">
        <div class="custom-game-title">${icon("plus", 18)} ${esc(t("customGames.addTitle"))}</div>
        <button class="modal-close-btn" data-act="close-custom-game-modal" title="${esc(t("common.close"))}">${icon("x", 16)}</button>
      </div>

      <div class="custom-game-search-box">
        <label class="custom-search-label">${icon("search", 15)}
          <input type="text" id="custom-search-input" placeholder="${esc(t("customGames.searchPlaceholder"))}" autocomplete="off" />
        </label>
        <div id="custom-search-results" class="custom-search-dropdown hidden"></div>
      </div>

      <div class="custom-game-form">
        <div class="custom-form-row preview-row">
          <div class="custom-cover-preview" id="custom-cover-preview">
            <div class="cover-placeholder">${icon("gamepad-2", 36)}</div>
          </div>
          <div class="custom-form-meta">
            <label class="custom-field">
              <span>${esc(t("customGames.fieldTitle"))} <strong class="req">*</strong></span>
              <input type="text" id="custom-title-input" required />
            </label>
            <div class="custom-field-split">
              <label class="custom-field">
                <span>${esc(t("customGames.fieldYear"))}</span>
                <input type="number" id="custom-year-input" placeholder="2005" />
              </label>
              <label class="custom-field">
                <span>${esc(t("customGames.fieldSteamAppId"))}</span>
                <input type="text" id="custom-appid-input" placeholder="e.g. 1262540" />
              </label>
            </div>
          </div>
        </div>

        <label class="custom-field">
          <span>${esc(t("customGames.fieldExe"))}</span>
          <div class="custom-exe-input-wrap">
            <input type="text" id="custom-exe-input" placeholder="C:\\Games\\...\\game.exe" />
            <button type="button" class="btn ghost small" data-act="pick-custom-exe">${icon("folder", 13)} ${esc(t("customGames.browse"))}</button>
          </div>
        </label>

        <label class="custom-field">
          <span>${esc(t("customGames.fieldArgs"))}</span>
          <input type="text" id="custom-args-input" placeholder="-windowed -novid" />
        </label>

        <label class="custom-field">
          <span>${esc(t("customGames.fieldCoverUrl"))}</span>
          <input type="text" id="custom-cover-input" placeholder="https://..." />
        </label>

        <label class="custom-field">
          <span>${esc(t("customGames.fieldDesc"))}</span>
          <textarea id="custom-desc-input" rows="3"></textarea>
        </label>
      </div>

      <div class="custom-game-footer">
        <button class="btn ghost" data-act="close-custom-game-modal">${esc(t("common.cancel"))}</button>
        <button class="btn play" data-act="save-custom-game">${icon("check", 14)} ${esc(t("customGames.save"))}</button>
      </div>
    </div>
  `;

  attachSearchListeners(backdrop);
}

function attachSearchListeners(modalEl: HTMLElement): void {
  const searchInput = modalEl.querySelector<HTMLInputElement>("#custom-search-input");
  const resultsDropdown = modalEl.querySelector<HTMLElement>("#custom-search-results");
  const coverInput = modalEl.querySelector<HTMLInputElement>("#custom-cover-input");
  const coverPreview = modalEl.querySelector<HTMLElement>("#custom-cover-preview");

  if (coverInput && coverPreview) {
    coverInput.addEventListener("input", () => {
      const url = coverInput.value.trim();
      if (url) {
        coverPreview.innerHTML = `<img src="${esc(url)}" alt="Cover" onerror="this.parentElement.innerHTML='${icon("gamepad-2", 36)}'" />`;
      } else {
        coverPreview.innerHTML = `<div class="cover-placeholder">${icon("gamepad-2", 36)}</div>`;
      }
    });
  }

  if (searchInput && resultsDropdown) {
    searchInput.addEventListener("input", () => {
      const query = searchInput.value.trim();
      if (searchTimeout) clearTimeout(searchTimeout);
      if (query.length < 2) {
        resultsDropdown.classList.add("hidden");
        resultsDropdown.innerHTML = "";
        return;
      }

      searchTimeout = setTimeout(async () => {
        try {
          const hits = await customGamesSearchSteam(query);
          currentHits = hits;
          if (hits.length === 0) {
            resultsDropdown.innerHTML = `<div class="search-result-empty">${esc(t("common.noResults"))}</div>`;
            resultsDropdown.classList.remove("hidden");
            return;
          }

          resultsDropdown.innerHTML = hits.map((hit, idx) => `
            <div class="search-result-item" data-hit-idx="${idx}">
              <img src="${esc(hit.coverUrl)}" class="result-thumb" onerror="this.style.display='none'" />
              <div class="result-info">
                <span class="result-name">${esc(hit.name)}</span>
                <span class="result-sub">Steam AppID: ${hit.id}</span>
              </div>
            </div>
          `).join("");
          resultsDropdown.classList.remove("hidden");
        } catch {
          resultsDropdown.classList.add("hidden");
        }
      }, 250);
    });

    resultsDropdown.addEventListener("click", async (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>(".search-result-item");
      if (!item?.dataset.hitIdx) return;
      const idx = Number(item.dataset.hitIdx);
      const hit = currentHits[idx];
      if (!hit) return;

      const titleInput = modalEl.querySelector<HTMLInputElement>("#custom-title-input");
      const appidInput = modalEl.querySelector<HTMLInputElement>("#custom-appid-input");
      const coverInput = modalEl.querySelector<HTMLInputElement>("#custom-cover-input");
      const descInput = modalEl.querySelector<HTMLTextAreaElement>("#custom-desc-input");
      const yearInput = modalEl.querySelector<HTMLInputElement>("#custom-year-input");

      if (titleInput) titleInput.value = hit.name;
      if (appidInput) appidInput.value = String(hit.id);
      if (coverInput) {
        coverInput.value = hit.coverUrl;
        if (coverPreview) {
          coverPreview.innerHTML = `<img src="${esc(hit.coverUrl)}" alt="Cover" />`;
        }
      }

      resultsDropdown.classList.add("hidden");
      if (searchInput) searchInput.value = hit.name;

      // Fetch store details in background to auto-fill description and year
      try {
        const details = await customGamesSteamDetails(String(hit.id));
        if (descInput && !descInput.value && details.shortDescription) {
          descInput.value = details.shortDescription;
        }
        if (yearInput && !yearInput.value && details.releaseYear) {
          yearInput.value = String(details.releaseYear);
        }
      } catch {
        // best effort
      }
    });
  }
}

export async function handlePickCustomExe(): Promise<void> {
  const chosen = await customGamesPickFile();
  if (!chosen) return;
  const exeInput = document.getElementById("custom-exe-input") as HTMLInputElement | null;
  const titleInput = document.getElementById("custom-title-input") as HTMLInputElement | null;
  if (exeInput) exeInput.value = chosen;

  // Auto-fill title if empty from filename
  if (titleInput && !titleInput.value.trim()) {
    const filename = chosen.split(/[\\/]/).pop() || "";
    const cleanTitle = filename.replace(/\.(exe|bat|cmd|lnk)$/i, "").replace(/[-_]/g, " ");
    titleInput.value = cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1);
  }
}

export async function handleSaveCustomGame(): Promise<void> {
  const titleInput = document.getElementById("custom-title-input") as HTMLInputElement | null;
  const exeInput = document.getElementById("custom-exe-input") as HTMLInputElement | null;
  const argsInput = document.getElementById("custom-args-input") as HTMLInputElement | null;
  const coverInput = document.getElementById("custom-cover-input") as HTMLInputElement | null;
  const descInput = document.getElementById("custom-desc-input") as HTMLTextAreaElement | null;
  const yearInput = document.getElementById("custom-year-input") as HTMLInputElement | null;
  const appidInput = document.getElementById("custom-appid-input") as HTMLInputElement | null;

  const title = titleInput?.value.trim() || "";
  const exePath = exeInput?.value.trim() || "";

  if (!title) {
    toast(t("customGames.fieldTitle"), "err");
    return;
  }

  const launchArgs = argsInput?.value.trim() || undefined;
  const coverUrl = coverInput?.value.trim() || undefined;
  const description = descInput?.value.trim() || undefined;
  const releaseYear = yearInput?.value ? Number(yearInput.value) : undefined;
  const steamAppId = appidInput?.value.trim() || undefined;

  try {
    const saved = await customGamesAdd({
      id: "",
      title,
      exePath,
      launchArgs,
      coverUrl,
      headerUrl: coverUrl,
      heroUrl: coverUrl,
      description,
      releaseYear,
      genres: [],
      steamAppId,
      addedAt: 0,
    });

    await loadCustomGamesLibrary();
    closeAddCustomGameModal();
    toast(t("customGames.addedSuccess", { title: saved.title }), "ok");
    render();
  } catch (e) {
    toast(String(e), "err");
  }
}

export async function handlePickExeForGame(id: string): Promise<void> {
  const chosen = await customGamesPickFile();
  if (!chosen) return;
  const game = S.customGames.find((g) => g.id === id);
  if (!game) return;
  const updated = { ...game, exePath: chosen };
  try {
    await customGamesEdit(updated);
    await loadCustomGamesLibrary();
    toast(t("customGames.exeSetSuccess"), "ok");
    render();
  } catch (e) {
    toast(String(e), "err");
  }
}
