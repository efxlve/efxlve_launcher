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
  type CustomGame,
  type SteamGameStoreDetails,
} from "../../custom-games";
import { igdbGame, igdbImage, igdbSearch } from "../../igdb";
import { loadCustomGamesLibrary } from "./custom-games-library";

/** A search row from either store metadata source. */
interface SearchHit {
  source: "steam" | "igdb";
  /** Steam AppID or IGDB id, kept as a string for both. */
  id: string;
  name: string;
  year?: number | null;
  coverUrl: string;
  headerUrl: string;
  heroUrl: string;
}

let searchTimeout: ReturnType<typeof setTimeout> | null = null;
let currentHits: SearchHit[] = [];
let escapeWired = false;

/** Escape closes the form before any other modal handler sees the key. */
function wireEscape(): void {
  if (escapeWired) return;
  escapeWired = true;
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || !document.querySelector(".custom-game-modal")) return;
      event.preventDefault();
      event.stopPropagation();
      closeAddCustomGameModal();
    },
    true,
  );
}
/** The game being edited; null while adding a new one. */
let editingId: string | null = null;
/** Artwork of the search hit selected in this session, if any. */
let pickedHit: SearchHit | null = null;
let pickedDetails: SteamGameStoreDetails | null = null;
/** A save is in flight; a second click must not add/update twice. */
let saving = false;

export function openAddCustomGameModal(): void {
  editingId = null;
  pickedHit = null;
  pickedDetails = null;
  S.isAddCustomGameOpen = true;
  wireEscape();
  renderCustomGameModal();
}

/** Opens the same form prefilled with an existing custom game. */
export function openEditCustomGameModal(id: string): void {
  const game = S.customGames.find((item) => item.id === id);
  if (!game) return;
  editingId = id;
  pickedHit = null;
  pickedDetails = game.genres?.length
    ? { name: game.title, shortDescription: "", headerImage: "", developers: [], genres: game.genres }
    : null;
  S.isAddCustomGameOpen = true;
  wireEscape();
  renderCustomGameModal();
}

export function closeAddCustomGameModal(): void {
  S.isAddCustomGameOpen = false;
  currentHits = [];
  editingId = null;
  pickedHit = null;
  pickedDetails = null;
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

  const game = editingId ? S.customGames.find((item) => item.id === editingId) : undefined;
  backdrop.innerHTML = `
    <div class="modal custom-game-modal" data-act="prevent-modal-close">
      <div class="custom-game-head">
        <div class="custom-game-title">${icon(editingId ? "edit" : "plus", 18)} ${esc(t(editingId ? "customGames.editTitle" : "customGames.addTitle"))}</div>
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
            ${game?.coverUrl ? `<img src="${esc(game.coverUrl)}" alt="Cover" />` : `<div class="cover-placeholder">${icon("gamepad-2", 36)}</div>`}
          </div>
          <div class="custom-form-meta">
            <label class="custom-field">
              <span>${esc(t("customGames.fieldTitle"))} <strong class="req">*</strong></span>
              <input type="text" id="custom-title-input" value="${esc(game?.title ?? "")}" required />
            </label>
            <div class="custom-field-split">
              <label class="custom-field">
                <span>${esc(t("customGames.fieldYear"))}</span>
                <input type="number" id="custom-year-input" placeholder="2005" value="${game?.releaseYear ?? ""}" />
              </label>
              <label class="custom-field">
                <span>${esc(t("customGames.fieldSteamAppId"))}</span>
                <input type="text" id="custom-appid-input" placeholder="e.g. 1262540" value="${esc(game?.steamAppId ?? "")}" />
              </label>
            </div>
          </div>
        </div>

        <label class="custom-field">
          <span>${esc(t("customGames.fieldExe"))}</span>
          <div class="custom-exe-input-wrap">
            <input type="text" id="custom-exe-input" placeholder="C:\\Games\\...\\game.exe" value="${esc(game?.exePath ?? "")}" />
            <button type="button" class="btn ghost small" data-act="pick-custom-exe">${icon("folder", 13)} ${esc(t("customGames.browse"))}</button>
          </div>
        </label>

        <label class="custom-field">
          <span>${esc(t("customGames.fieldArgs"))}</span>
          <input type="text" id="custom-args-input" placeholder="-windowed -novid" value="${esc(game?.launchArgs ?? "")}" />
        </label>

        <label class="custom-field">
          <span>${esc(t("customGames.fieldCoverUrl"))}</span>
          <input type="text" id="custom-cover-input" placeholder="https://..." value="${esc(game?.coverUrl ?? "")}" />
        </label>

        <label class="custom-field">
          <span>${esc(t("customGames.fieldDesc"))}</span>
          <textarea id="custom-desc-input" rows="3">${esc(game?.description ?? "")}</textarea>
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
      // A hand-typed cover is no longer the selected store hit's artwork.
      pickedHit = null;
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
          let hits: SearchHit[] = [];
          try {
            hits = (await customGamesSearchSteam(query)).map((hit) => ({
              source: "steam",
              id: String(hit.id),
              name: hit.name,
              coverUrl: hit.coverUrl,
              headerUrl: hit.headerUrl,
              heroUrl: hit.heroUrl,
            }));
          } catch {
            // Steam Store unreachable: still try the second metadata source.
          }
          // No store match: IGDB still knows games Steam never listed.
          if (hits.length === 0) {
            try {
              hits = (await igdbSearch(query, 8)).map((hit) => ({
                source: "igdb",
                id: String(hit.id),
                name: hit.name,
                year: hit.year,
                coverUrl: igdbImage(hit.coverId, "cover_big_2x"),
                headerUrl: igdbImage(hit.coverId, "cover_big"),
                heroUrl: igdbImage(hit.coverId, "cover_big"),
              }));
            } catch {
              // IGDB is optional; an unconfigured proxy simply means no rows.
            }
          }
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
                <span class="result-sub">${hit.source === "steam" ? `Steam AppID: ${hit.id}` : `IGDB${hit.year ? ` · ${hit.year}` : ""}`}</span>
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
      if (appidInput) appidInput.value = hit.source === "steam" ? hit.id : "";
      pickedHit = hit;
      if (coverInput) {
        coverInput.value = hit.coverUrl;
        if (coverPreview && hit.coverUrl) {
          coverPreview.innerHTML = `<img src="${esc(hit.coverUrl)}" alt="Cover" />`;
        }
      }

      resultsDropdown.classList.add("hidden");
      if (searchInput) searchInput.value = hit.name;

      // Fetch the metadata in the background to auto-fill the form.
      try {
        if (hit.source === "steam") {
          const details = await customGamesSteamDetails(hit.id);
          pickedDetails = details;
          if (descInput && !descInput.value && details.shortDescription) {
            descInput.value = details.shortDescription;
          }
          if (yearInput && !yearInput.value && details.releaseYear) {
            yearInput.value = String(details.releaseYear);
          }
        } else {
          const game = await igdbGame(Number(hit.id));
          pickedDetails = {
            name: game.name,
            shortDescription: game.summary,
            headerImage: hit.headerUrl,
            developers: game.developer ? [game.developer] : [],
            genres: game.genres,
            releaseYear: game.pcReleaseYear ?? game.releaseYear ?? undefined,
          };
          if (titleInput) titleInput.value = game.name;
          if (descInput && !descInput.value && game.summary) descInput.value = game.summary;
          const year = game.pcReleaseYear ?? game.releaseYear;
          if (yearInput && !yearInput.value && year) yearInput.value = String(year);
        }
      } catch {
        if (hit.source === "igdb" && yearInput && !yearInput.value && hit.year) {
          yearInput.value = String(hit.year);
        }
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
  if (saving) return;
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

  const base = editingId ? S.customGames.find((item) => item.id === editingId) : undefined;
  const payload: CustomGame = {
    id: base?.id ?? "",
    title,
    exePath,
    launchArgs,
    coverUrl,
    headerUrl: pickedHit?.headerUrl || base?.headerUrl || coverUrl,
    heroUrl: pickedHit?.heroUrl || base?.heroUrl || coverUrl,
    description,
    developer: pickedDetails?.developers?.filter(Boolean).join(", ") || base?.developer,
    releaseYear: releaseYear ?? base?.releaseYear,
    genres: pickedDetails?.genres?.length ? pickedDetails.genres : (base?.genres ?? []),
    steamAppId,
    addedAt: base?.addedAt ?? 0,
  };

  saving = true;
  const saveButton = document.querySelector<HTMLButtonElement>('[data-act="save-custom-game"]');
  if (saveButton) saveButton.disabled = true;
  try {
    const saved = base ? await customGamesEdit(payload) : await customGamesAdd(payload);
    await loadCustomGamesLibrary();
    closeAddCustomGameModal();
    toast(
      t(base ? "customGames.updatedSuccess" : "customGames.addedSuccess", { title: saved.title }),
      "ok",
    );
    render();
  } catch (e) {
    toast(String(e), "err");
  } finally {
    saving = false;
    if (saveButton) saveButton.disabled = false;
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
