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
/** Bumped per keystroke so a slow source cannot paint an older query. */
let searchSeq = 0;
let currentHits: SearchHit[] = [];
let escapeWired = false;

/** Letters and digits only, so one game is not listed twice under two spellings. */
function hitNameKey(name: string): string {
  return name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Steam rows stay above IGDB when the two sources answer out of order. */
function orderedHits(hits: SearchHit[]): SearchHit[] {
  return [...hits].sort(
    (a, b) => Number(a.source !== "steam") - Number(b.source !== "steam"),
  );
}

/** Dropdown rows, capped so two sources cannot bury the form. */
function searchResultRows(hits: SearchHit[]): string {
  return hits
    .slice(0, 12)
    .map(
      (hit, idx) => `
            <div class="search-result-item" data-hit-idx="${idx}">
              <img src="${esc(hit.coverUrl)}" class="result-thumb" onerror="this.style.display='none'" />
              <div class="result-info">
                <span class="result-name">${esc(hit.name)}</span>
                <span class="result-sub">${hit.source === "steam" ? `Steam AppID: ${hit.id}` : `IGDB${hit.year ? ` · ${hit.year}` : ""}`}</span>
              </div>
            </div>
          `,
    )
    .join("");
}

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
/** Cover chosen from disk in this session, stored as a data URL. */
let pickedCover: string | null = null;
let pickedDetails: SteamGameStoreDetails | null = null;

/** Largest edge of a stored cover: the card stays sharp and the JSON small. */
const COVER_MAX_W = 640;
const COVER_MAX_H = 960;
/** A cover data URL past this size is re-encoded or rejected. */
const COVER_MAX_DATA_CHARS = 1_200_000;

/** Cover preview body: the picture (or the placeholder) and the upload hint. */
function coverPreviewHtml(src: string | null | undefined): string {
  const image = src
    ? `<img src="${esc(src)}" alt="Cover" />`
    : `<div class="cover-placeholder">${icon("gamepad-2", 36)}</div>`;
  return `${image}<span class="custom-cover-upload-chip">${icon("upload", 11)}<span>${esc(t("customGames.coverUpload"))}</span></span>`;
}

/** Paints a preview and falls back to the placeholder when the picture fails. */
function paintCoverPreview(preview: HTMLElement | null, src: string | null | undefined): void {
  if (!preview) return;
  preview.innerHTML = coverPreviewHtml(src);
  preview.querySelector("img")?.addEventListener(
    "error",
    () => {
      preview.innerHTML = coverPreviewHtml(null);
    },
    { once: true },
  );
}
/** A save is in flight; a second click must not add/update twice. */
let saving = false;

export function openAddCustomGameModal(): void {
  editingId = null;
  pickedHit = null;
  pickedCover = null;
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
  pickedCover = game.coverUrl?.startsWith("data:") ? game.coverUrl : null;
  pickedDetails = game.genres?.length
    ? { name: game.title, shortDescription: "", headerImage: "", developers: [], genres: game.genres }
    : null;
  S.isAddCustomGameOpen = true;
  wireEscape();
  renderCustomGameModal();
}

export function closeAddCustomGameModal(): void {
  S.isAddCustomGameOpen = false;
  searchSeq += 1;
  if (searchTimeout) {
    clearTimeout(searchTimeout);
    searchTimeout = null;
  }
  currentHits = [];
  editingId = null;
  pickedHit = null;
  pickedCover = null;
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
  // An uploaded cover is a data URL far too long for the text field; the
  // preview carries it and the field stays empty.
  const coverUrlValue = game?.coverUrl && !game.coverUrl.startsWith("data:") ? game.coverUrl : "";
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
          <div class="custom-cover-preview" id="custom-cover-preview" role="button" tabindex="0" data-act="pick-custom-cover" title="${esc(t("customGames.coverUpload"))}">
            ${coverPreviewHtml(game?.coverUrl)}
          </div>
          <input type="file" id="custom-game-cover-file-input" accept="image/png,image/jpeg,image/webp,image/bmp,image/gif" hidden />
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
          <input type="text" id="custom-cover-input" placeholder="https://..." value="${esc(coverUrlValue)}" />
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
  // Re-paint once so a broken cover URL falls back to the placeholder, and the
  // initial picture gets the same error handler as later updates.
  paintCoverPreview(backdrop.querySelector<HTMLElement>("#custom-cover-preview"), game?.coverUrl);
}

function attachSearchListeners(modalEl: HTMLElement): void {
  const searchInput = modalEl.querySelector<HTMLInputElement>("#custom-search-input");
  const resultsDropdown = modalEl.querySelector<HTMLElement>("#custom-search-results");
  const coverInput = modalEl.querySelector<HTMLInputElement>("#custom-cover-input");
  const coverPreview = modalEl.querySelector<HTMLElement>("#custom-cover-preview");
  const coverFileInput = modalEl.querySelector<HTMLInputElement>("#custom-game-cover-file-input");

  if (coverInput && coverPreview) {
    coverInput.addEventListener("input", () => {
      const url = coverInput.value.trim();
      // A hand-typed cover is no longer the selected store hit's artwork, and
      // it replaces a cover uploaded earlier in this session.
      pickedHit = null;
      pickedCover = null;
      paintCoverPreview(coverPreview, url || null);
    });
  }

  coverFileInput?.addEventListener("change", () => {
    void applyPickedCover(coverFileInput);
  });

  if (searchInput && resultsDropdown) {
    searchInput.addEventListener("input", () => {
      const query = searchInput.value.trim();
      const generation = ++searchSeq;
      if (searchTimeout) clearTimeout(searchTimeout);
      // Rows of the previous query are not this query's answers.
      resultsDropdown.classList.add("hidden");
      resultsDropdown.innerHTML = "";
      currentHits = [];
      if (query.length < 2) return;

      searchTimeout = setTimeout(() => {
        const hits: SearchHit[] = [];
        const seen = new Set<string>();
        let pending = 2;

        const paint = (final: boolean) => {
          if (generation !== searchSeq) return;
          currentHits = orderedHits(hits);
          if (currentHits.length > 0) {
            resultsDropdown.innerHTML = searchResultRows(currentHits);
            resultsDropdown.classList.remove("hidden");
          } else if (final) {
            resultsDropdown.innerHTML = `<div class="search-result-empty">${esc(t("common.noResults"))}</div>`;
            resultsDropdown.classList.remove("hidden");
          }
        };
        const settle = () => {
          pending -= 1;
          if (pending === 0) paint(true);
        };

        // The two sources answer independently: Steam rows appear at once and
        // IGDB adds what Steam does not sell, such as console-only titles.
        void customGamesSearchSteam(query)
          .then((rows) => {
            if (generation !== searchSeq) return;
            for (const hit of rows) {
              const key = hitNameKey(hit.name);
              if (seen.has(key)) continue;
              seen.add(key);
              hits.push({
                source: "steam",
                id: String(hit.id),
                name: hit.name,
                coverUrl: hit.coverUrl,
                headerUrl: hit.headerUrl,
                heroUrl: hit.heroUrl,
              });
            }
            paint(false);
          })
          .catch(() => undefined)
          .finally(settle);

        void igdbSearch(query, 8)
          .then((rows) => {
            if (generation !== searchSeq) return;
            for (const hit of rows) {
              const key = hitNameKey(hit.name);
              if (seen.has(key)) continue;
              seen.add(key);
              hits.push({
                source: "igdb",
                id: String(hit.id),
                name: hit.name,
                year: hit.year,
                coverUrl: igdbImage(hit.coverId, "cover_big_2x"),
                headerUrl: igdbImage(hit.coverId, "cover_big"),
                heroUrl: igdbImage(hit.coverId, "cover_big"),
              });
            }
            paint(false);
          })
          .catch(() => undefined)
          .finally(settle);
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
      pickedCover = null;
      if (coverInput) coverInput.value = hit.coverUrl;
      paintCoverPreview(coverPreview, hit.coverUrl);

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

/** Opens the file picker behind the cover placeholder. */
export function handlePickCustomCover(): void {
  document.getElementById("custom-game-cover-file-input")?.click();
}

/**
 * Shrinks a picked picture to cover size, so the library JSON never carries a
 * multi-megabyte photo. `img.decode` handles every format the WebView reads.
 */
async function coverFromFile(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("not an image");
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) throw new Error("empty image");
    const scale = Math.min(1, COVER_MAX_W / width, COVER_MAX_H / height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    let dataUrl = canvas.toDataURL("image/webp", 0.9);
    if (dataUrl.length > COVER_MAX_DATA_CHARS) {
      dataUrl = canvas.toDataURL("image/jpeg", 0.78);
    }
    if (dataUrl.length > COVER_MAX_DATA_CHARS) throw new Error("too large");
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** Reads the chosen file into the preview; the URL field stays the other way in. */
async function applyPickedCover(input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  // Clearing the field lets the same file be picked again after a cancel.
  input.value = "";
  if (!file) return;
  try {
    pickedCover = await coverFromFile(file);
    pickedHit = null;
    const coverInput = document.getElementById("custom-cover-input") as HTMLInputElement | null;
    if (coverInput) coverInput.value = "";
    paintCoverPreview(document.getElementById("custom-cover-preview"), pickedCover);
  } catch {
    toast(t("customGames.coverUploadFailed"), "err");
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
  // An uploaded cover wins over the URL field; typing a URL clears it above.
  const coverUrl = pickedCover || coverInput?.value.trim() || undefined;
  const description = descInput?.value.trim() || undefined;
  const releaseYear = yearInput?.value ? Number(yearInput.value) : undefined;
  const steamAppId = appidInput?.value.trim() || undefined;

  const base = editingId ? S.customGames.find((item) => item.id === editingId) : undefined;
  // Store art outlives a new cover; a previous upload does not, or the hero
  // would keep showing the picture the user just replaced.
  const baseHeader = base?.headerUrl && base.headerUrl !== base.coverUrl && !base.headerUrl.startsWith("data:") ? base.headerUrl : undefined;
  const baseHero = base?.heroUrl && base.heroUrl !== base.coverUrl && !base.heroUrl.startsWith("data:") ? base.heroUrl : undefined;
  const payload: CustomGame = {
    id: base?.id ?? "",
    title,
    exePath,
    launchArgs,
    coverUrl,
    headerUrl: pickedHit?.headerUrl || baseHeader || (pickedCover ? undefined : coverUrl),
    heroUrl: pickedHit?.heroUrl || baseHero || (pickedCover ? undefined : coverUrl),
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
