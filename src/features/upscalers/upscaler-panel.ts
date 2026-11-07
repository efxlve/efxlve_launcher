/**
 * Per-game upscaler DLL panel.
 *
 * The panel lists the DLSS, FSR and XeSS files a game already ships. The user
 * can replace one with a local file or a signed catalog download; the original
 * stays beside the game file as a `.dlsss` backup.
 */

import { askConfirm } from "../../core/confirm-dialog";
import { icon } from "../../core/icons";
import { toast } from "../../core/toast";
import { esc, fmtBytes } from "../../core/utils";
import { t } from "../../i18n";
import {
  upscalersCatalog,
  upscalersDiscardBackup,
  upscalersDownloadLatest,
  upscalersDownloadSwap,
  upscalersImportDll,
  upscalersListImported,
  upscalersPickDll,
  upscalersRestore,
  upscalersScanGame,
  upscalersSwap,
  type CatalogEntry,
  type GameUpscalers,
  type ImportedDll,
  type UpscalerDll,
  type UpscalerKind,
} from "../../upscalers";

interface ManageGameLike {
  appName: string;
  installPath: string | null;
}

const KIND_LABEL: Record<UpscalerKind, string> = {
  dlss: "DLSS Super Resolution",
  dlssFg: "DLSS Frame Generation",
  dlssRr: "DLSS Ray Reconstruction",
  fsr31Dx12: "FSR 3.1 (DirectX 12)",
  fsr31Vk: "FSR 3.1 (Vulkan)",
  xess: "XeSS",
  xessDx11: "XeSS (DirectX 11)",
  xessFg: "XeSS Frame Generation",
  xell: "XeLL",
};

function kindDescription(kind: UpscalerKind): string {
  switch (kind) {
    case "dlss":
      return t("upscaler.descDlss");
    case "dlssFg":
      return t("upscaler.descDlssFg");
    case "dlssRr":
      return t("upscaler.descDlssRr");
    case "fsr31Dx12":
      return t("upscaler.descFsrDx12");
    case "fsr31Vk":
      return t("upscaler.descFsrVk");
    case "xess":
      return t("upscaler.descXess");
    case "xessDx11":
      return t("upscaler.descXessDx11");
    case "xessFg":
      return t("upscaler.descXessFg");
    case "xell":
      return t("upscaler.descXell");
  }
}

const CATALOG_TTL_MS = 10 * 60 * 1000;
let catalogCache: { at: number; entries: CatalogEntry[] } | null = null;

async function loadCatalog(force: boolean): Promise<CatalogEntry[]> {
  if (!force && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.entries;
  }
  const entries = await upscalersCatalog(force);
  catalogCache = { at: Date.now(), entries };
  return entries;
}

/** The Manage panel adds this section only for an installed path. */
export function upscalerGroup(game: ManageGameLike): string {
  const installPath = (game.installPath || "").trim();
  if (!installPath) return "";
  return `
    <section class="manage-group" data-tab="graphics" data-title="${esc(t("upscaler.title"))}" data-nav="${esc(t("upscaler.nav"))}" data-icon="cpu" id="manage-panel-graphics">
      <h3 class="manage-group-title">${icon("cpu", 14)} ${esc(t("upscaler.title"))}</h3>
      <div class="list">
        <div class="row mg-row stack" data-search="${esc(`${t("upscaler.title")} ${t("upscaler.desc")}`)}">
          <div class="mg-title">${esc(t("upscaler.title"))}</div>
          <div class="mg-desc">${esc(t("upscaler.desc"))}</div>
          <div class="mg-note">${icon("info", 12)} ${esc(t("upscaler.closeGame"))}</div>
          <div class="mg-inline">
            <button class="btn ghost small" data-act="upscaler-refresh">${icon("refresh", 13)} ${esc(t("upscaler.rescan"))}</button>
            <button class="btn primary small" data-act="upscaler-update-all" disabled>${icon("download", 13)} ${esc(t("upscaler.updateAll"))}</button>
            <button class="btn ghost small" data-act="upscaler-import">${icon("upload", 13)} ${esc(t("upscaler.import"))}</button>
          </div>
        </div>
        <div data-upscaler-root data-game-key="${esc(game.appName)}" data-install-path="${esc(installPath)}">
          <div data-upscaler-body><div class="mg-note">${esc(t("upscaler.scanning"))}</div></div>
        </div>
        <div class="mg-note upscaler-legal">${icon("info", 12)} ${esc(t("upscaler.legal"))}</div>
      </div>
    </section>`;
}

function catalogByKind(entries: CatalogEntry[]): Map<UpscalerKind, CatalogEntry[]> {
  const grouped = new Map<UpscalerKind, CatalogEntry[]>();
  for (const entry of entries) {
    if (!entry.isSigned) continue;
    const list = grouped.get(entry.kind) ?? [];
    list.push(entry);
    grouped.set(entry.kind, list);
  }
  for (const list of grouped.values()) {
    list.sort((left, right) => {
      return (
        right.versionNumber - left.versionNumber ||
        Number(left.isDev) - Number(right.isDev)
      );
    });
  }
  return grouped;
}

function importedByKind(entries: ImportedDll[]): Map<UpscalerKind, ImportedDll[]> {
  const grouped = new Map<UpscalerKind, ImportedDll[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.kind) ?? [];
    list.push(entry);
    grouped.set(entry.kind, list);
  }
  for (const list of grouped.values()) {
    list.sort((left, right) => right.importedAt - left.importedAt);
  }
  return grouped;
}

function catalogLabel(entry: CatalogEntry): string {
  const beta = entry.isDev ? ` (${t("upscaler.beta")})` : "";
  const extra = entry.label ? ` · ${entry.label}` : "";
  return `v${entry.version}${beta}${extra} · ${fmtBytes(entry.fileSize)}`;
}

function importedLabel(entry: ImportedDll): string {
  const version = entry.version ? `v${entry.version}` : `v${t("upscaler.unknownVersion")}`;
  return `${version} · ${entry.fileName} · ${fmtBytes(entry.size)}`;
}

function renderDll(
  dll: UpscalerDll,
  imported: ImportedDll[],
  catalog: CatalogEntry[],
  catalogError: string,
  catalogLoading: boolean,
): string {
  // Same choice as the backend: newest signed stable, then newest signed beta.
  const latest = catalog.find((entry) => !entry.isDev) ?? catalog[0];
  const stateLabel = dll.state === "swapped" ? t("upscaler.swapped") : t("upscaler.original");
  const description = kindDescription(dll.kind);
  const versionLabel = dll.version
    ? `v${esc(dll.version)}`
    : esc(t("upscaler.unknownVersion"));
  const backupLabel = dll.backupPath
    ? esc(
        t("upscaler.backup", {
          version: dll.backupVersion ? `v${dll.backupVersion}` : "?",
        }),
      )
    : esc(t("upscaler.noBackup"));
  const search = `${KIND_LABEL[dll.kind]} ${versionLabel} ${stateLabel} ${description} ${dll.path} ${backupLabel}`;

  const catalogOptions = catalog
    .map(
      (entry) =>
        `<option value="${esc(entry.md5)}">${esc(catalogLabel(entry))}</option>`,
    )
    .join("");
  const importedOptions = imported
    .map(
      (entry) =>
        `<option value="${esc(entry.id)}">${esc(importedLabel(entry))}</option>`,
    )
    .join("");

  const downloadLatest = latest
    ? `<button class="btn primary small" data-act="upscaler-download-latest" data-kind="${dll.kind}" data-dll-path="${esc(dll.path)}">${icon("download", 13)} ${esc(
        t("upscaler.downloadLatest", { version: latest.version }),
      )}</button>`
    : catalogLoading
      ? `<span class="chip">${esc(t("upscaler.loadingCatalog"))}</span>`
      : `<span class="chip">${esc(t("upscaler.catalogUnavailable"))}</span>`;

  return `
    <div class="row mg-row stack upscaler-row" data-upscaler-dll data-dll-path="${esc(dll.path)}" data-kind="${dll.kind}" data-version="${esc(dll.version)}" data-latest-version="${latest ? esc(latest.version) : ""}" data-search="${esc(search)}">
      <div class="upscaler-head">
        <div class="mg-title">${esc(KIND_LABEL[dll.kind])} <span class="chip ${dll.state === "swapped" ? "warn" : "ok"}">${esc(stateLabel)}</span></div>
        <div class="mg-desc"><span class="tabular-nums">${versionLabel}</span> · ${fmtBytes(dll.size)}</div>
      </div>
      <div class="mg-path upscaler-path">${esc(dll.path)}</div>
      <div class="mg-desc upscaler-desc">${esc(description)}</div>
      <div class="upscaler-actions">
        ${downloadLatest}
        <button class="btn ghost small" data-act="upscaler-restore" data-dll-path="${esc(dll.path)}" ${dll.backupPath ? "" : "disabled"}>${icon("refresh", 13)} ${esc(t("upscaler.restore"))}</button>
        ${
          dll.backupPath
            ? `<button class="btn ghost small" data-act="upscaler-discard" data-dll-path="${esc(dll.path)}" title="${esc(t("upscaler.discard"))}">${icon("trash", 13)} ${esc(t("upscaler.discard"))}</button>`
            : ""
        }
      </div>
      <div class="mg-note">${backupLabel}</div>
      <details class="upscaler-more">
        <summary>${esc(t("upscaler.moreVersions"))}</summary>
        <div class="upscaler-more-body">
          <div class="upscaler-line">
            <span class="upscaler-line-label">${esc(t("upscaler.catalogVersions"))}</span>
            ${
              catalog.length
                ? `<select class="settings-select" data-upscaler-catalog>${catalogOptions}</select>
                   <button class="btn ghost small" data-act="upscaler-download-selected" data-kind="${dll.kind}" data-dll-path="${esc(dll.path)}">${esc(t("upscaler.downloadSelected"))}</button>`
                : catalogLoading
                  ? `<span class="mg-note">${esc(t("upscaler.loadingCatalog"))}</span>`
                  : `<span class="mg-note">${esc(catalogError ? t("upscaler.catalogError") : t("upscaler.noCatalog"))}</span>`
            }
          </div>
          <div class="upscaler-line">
            <span class="upscaler-line-label">${esc(t("upscaler.localVersions"))}</span>
            ${
              imported.length
                ? `<select class="settings-select" data-upscaler-imported>${importedOptions}</select>
                   <button class="btn ghost small" data-act="upscaler-apply-imported" data-kind="${dll.kind}" data-dll-path="${esc(dll.path)}">${esc(t("upscaler.applyImported"))}</button>`
                : `<span class="mg-note">${esc(t("upscaler.noImported"))}</span>`
            }
          </div>
        </div>
      </details>
    </div>`;
}

/** Enables the one-click update only when a row has a newer catalog version. */
function refreshUpdateAllState(root: HTMLElement): void {
  const button = root
    .closest("section")
    ?.querySelector<HTMLButtonElement>('[data-act="upscaler-update-all"]');
  if (!button) return;
  button.disabled = !root.querySelector('[data-act="upscaler-download-latest"]');
}

function renderBody(
  scan: GameUpscalers | { error: string },
  imported: ImportedDll[],
  catalog: CatalogEntry[],
  catalogError: string,
  catalogLoading: boolean,
): string {
  if ("error" in scan) {
    return `<div class="mg-note is-err">${esc(scan.error)}</div>`;
  }
  if (scan.dlls.length === 0) {
    return `<div class="mg-note">${esc(t("upscaler.empty"))}</div>`;
  }
  const importedGroups = importedByKind(imported);
  const catalogGroups = catalogByKind(catalog);
  return scan.dlls
    .map((dll) =>
      renderDll(
        dll,
        importedGroups.get(dll.kind) ?? [],
        catalogGroups.get(dll.kind) ?? [],
        catalogError,
        catalogLoading,
      ),
    )
    .join("");
}

/**
 * Loads the scan, the local cache and the catalog, then replaces only the
 * panel body. The Manage shell and the other tabs stay untouched.
 */
export async function hydrateUpscalerPanel(force = false): Promise<void> {
  const root = document.querySelector<HTMLElement>("[data-upscaler-root]");
  if (!root) return;
  if (!force && root.dataset.loaded === "1") return;
  const body = root.querySelector<HTMLElement>("[data-upscaler-body]");
  if (!body) return;

  const gameKey = root.dataset.gameKey ?? "";
  const installPath = root.dataset.installPath ?? "";
  if (!installPath) {
    body.innerHTML = `<div class="mg-note">${esc(t("upscaler.empty"))}</div>`;
    refreshUpdateAllState(root);
    return;
  }

  // A refresh or a tab switch can overlap an older scan; only the newest
  // generation is allowed to paint.
  const generation = String((Number(root.dataset.generation) || 0) + 1);
  root.dataset.generation = generation;
  const current = () =>
    root.isConnected &&
    root.dataset.gameKey === gameKey &&
    root.dataset.generation === generation;

  body.innerHTML = `<div class="mg-note">${esc(t("upscaler.scanning"))}</div>`;
  refreshUpdateAllState(root);
  const catalogPromise = loadCatalog(force)
    .then((entries) => ({ entries }))
    .catch((error: unknown) => ({
      error: String(error).replace(/^Error: /, ""),
    }));

  const scan = await upscalersScanGame(installPath, gameKey).catch((error: unknown) => ({
    error: String(error).replace(/^Error: /, ""),
  }));
  if (!current()) return;
  const imported = await upscalersListImported().catch(() => []);
  if (!current()) return;

  root.dataset.loaded = "1";
  const cached = catalogCache?.entries ?? [];
  body.innerHTML = renderBody(scan, imported, cached, "", cached.length === 0);
  refreshUpdateAllState(root);

  const catalogResult = await catalogPromise;
  if (!current()) return;
  if ("entries" in catalogResult) {
    body.innerHTML = renderBody(scan, imported, catalogResult.entries, "", false);
  } else {
    body.innerHTML = renderBody(scan, imported, [], catalogResult.error, false);
  }
  refreshUpdateAllState(root);
}

function panelRoot(element: HTMLElement): HTMLElement | null {
  return element.closest<HTMLElement>("[data-upscaler-root]");
}

function actionErrorMessage(error: unknown): string {
  return String(error).replace(/^Error: /, "");
}

async function confirmRisk(): Promise<boolean> {
  return askConfirm({
    title: t("upscaler.riskTitle"),
    body: t("upscaler.riskBody"),
    confirm: t("upscaler.continue"),
    cancel: t("common.cancel"),
  });
}

async function withBusy(button: HTMLElement, work: () => Promise<void>): Promise<void> {
  if (button instanceof HTMLButtonElement) button.disabled = true;
  const previous = button.innerHTML;
  button.textContent = t("upscaler.working");
  try {
    await work();
  } finally {
    if (button.isConnected) {
      button.innerHTML = previous;
      if (button instanceof HTMLButtonElement) button.disabled = false;
    }
  }
}

/** Click-router entry for every `upscaler-*` action. */
export async function handleUpscalerAction(
  act: string,
  element: HTMLElement,
): Promise<boolean> {
  if (!act.startsWith("upscaler-")) return false;
  const root = panelRoot(element);
  const installPath = root?.dataset.installPath ?? "";
  const dllPath = element.dataset.dllPath ?? "";
  const kind = element.dataset.kind as UpscalerKind | undefined;

  switch (act) {
    case "upscaler-refresh":
      await hydrateUpscalerPanel(true);
      return true;

    case "upscaler-update-all": {
      if (!installPath || !root) return true;
      const rows = Array.from(
        root.querySelectorAll<HTMLElement>("[data-upscaler-dll]"),
      ).filter((row) =>
        row.querySelector('[data-act="upscaler-download-latest"]'),
      );
      if (rows.length === 0) {
        toast(t("upscaler.noUpdates"), "");
        return true;
      }
      if (!(await confirmRisk())) return true;
      await withBusy(element, async () => {
        let done = 0;
        let updated = 0;
        const failures: string[] = [];
        for (const row of rows) {
          const path = row.dataset.dllPath ?? "";
          const kind = row.dataset.kind as UpscalerKind | undefined;
          const current = row.dataset.version ?? "";
          const latest = row.dataset.latestVersion ?? "";
          if (!path || !kind) continue;
          done += 1;
          if (current && latest && current === latest) {
            continue;
          }
          try {
            await upscalersDownloadLatest(installPath, path, kind);
            updated += 1;
          } catch (error) {
            failures.push(`${KIND_LABEL[kind]}: ${actionErrorMessage(error)}`);
          }
          if (element instanceof HTMLButtonElement) {
            element.textContent = t("upscaler.updating", {
              done,
              total: rows.length,
            });
          }
        }
        if (failures.length > 0) {
          toast(
            `${t("upscaler.updateAllPartial", {
              ok: updated,
              total: rows.length,
            })} ${failures[0]}`,
            "err",
          );
        } else if (updated === 0) {
          toast(t("upscaler.allCurrent"), "ok");
        } else {
          toast(t("upscaler.updatedAll", { count: updated }), "ok");
        }
        await hydrateUpscalerPanel(true);
      });
      return true;
    }

    case "upscaler-import": {
      const picked = await upscalersPickDll(t("upscaler.pickTitle")).catch(
        (error: unknown) => {
          toast(actionErrorMessage(error), "err");
          return null;
        },
      );
      if (!picked) return true;
      try {
        await upscalersImportDll(picked);
        toast(t("upscaler.imported"), "ok");
        await hydrateUpscalerPanel(true);
      } catch (error) {
        toast(actionErrorMessage(error), "err");
      }
      return true;
    }

    case "upscaler-download-latest": {
      if (!installPath || !dllPath || !kind) return true;
      if (!(await confirmRisk())) return true;
      await withBusy(element, async () => {
        try {
          await upscalersDownloadLatest(installPath, dllPath, kind);
          toast(t("upscaler.swappedOk"), "ok");
          await hydrateUpscalerPanel(true);
        } catch (error) {
          toast(actionErrorMessage(error), "err");
        }
      });
      return true;
    }

    case "upscaler-download-selected": {
      if (!installPath || !dllPath || !kind) return true;
      const select = element
        .closest(".upscaler-line")
        ?.querySelector<HTMLSelectElement>("[data-upscaler-catalog]");
      const md5 = select?.value ?? "";
      if (!md5) {
        toast(t("upscaler.pickVersion"), "");
        return true;
      }
      if (!(await confirmRisk())) return true;
      await withBusy(element, async () => {
        try {
          await upscalersDownloadSwap(installPath, dllPath, kind, md5);
          toast(t("upscaler.swappedOk"), "ok");
          await hydrateUpscalerPanel(true);
        } catch (error) {
          toast(actionErrorMessage(error), "err");
        }
      });
      return true;
    }

    case "upscaler-apply-imported": {
      if (!installPath || !dllPath) return true;
      const select = element
        .closest(".upscaler-line")
        ?.querySelector<HTMLSelectElement>("[data-upscaler-imported]");
      const importedId = select?.value ?? "";
      if (!importedId) {
        toast(t("upscaler.pickVersion"), "");
        return true;
      }
      if (!(await confirmRisk())) return true;
      await withBusy(element, async () => {
        try {
          await upscalersSwap(installPath, dllPath, importedId);
          toast(t("upscaler.swappedOk"), "ok");
          await hydrateUpscalerPanel(true);
        } catch (error) {
          toast(actionErrorMessage(error), "err");
        }
      });
      return true;
    }

    case "upscaler-restore": {
      if (!installPath || !dllPath) return true;
      const ok = await askConfirm({
        title: t("upscaler.confirmRestoreTitle"),
        body: t("upscaler.confirmRestoreBody"),
        confirm: t("upscaler.restore"),
        cancel: t("common.cancel"),
      });
      if (!ok) return true;
      await withBusy(element, async () => {
        try {
          await upscalersRestore(installPath, dllPath);
          toast(t("upscaler.restoredOk"), "ok");
          await hydrateUpscalerPanel(true);
        } catch (error) {
          toast(actionErrorMessage(error), "err");
        }
      });
      return true;
    }

    case "upscaler-discard": {
      if (!installPath || !dllPath) return true;
      const ok = await askConfirm({
        title: t("upscaler.confirmDiscardTitle"),
        body: t("upscaler.confirmDiscardBody"),
        confirm: t("upscaler.discard"),
        cancel: t("common.cancel"),
      });
      if (!ok) return true;
      await withBusy(element, async () => {
        try {
          await upscalersDiscardBackup(installPath, dllPath);
          toast(t("upscaler.discardedOk"), "ok");
          await hydrateUpscalerPanel(true);
        } catch (error) {
          toast(actionErrorMessage(error), "err");
        }
      });
      return true;
    }

    default:
      return false;
  }
}
