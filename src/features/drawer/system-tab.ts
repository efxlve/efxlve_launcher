/**
 * The game page's System tab.
 *
 * The requirements table is the page: one panel that pairs every store row
 * with the matching fact from this PC, and a single verdict above it. The side
 * column keeps the practical facts (this copy, controller, game features) that
 * used to compete with the table for the same grid.
 */

import { emptyPanel, icon, loadingState } from "../../core/icons";
import { isCompanionKey, rawOf, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import type { EpicSummary, ThirdPartyLauncherInfo } from "../../epic";
import { renderAntiCheatHost } from "./awacy";
import { renderDeckHost } from "./deck";
import { renderGameCompatCard } from "./game-compat";
import { igdbGameFor, igdbTagsFor } from "./igdb-view";
import { renderProtonDbHost } from "./protondb";
import {
  isMacSys,
  isWinSys,
  renderControllerCard,
  renderControllerHelp,
  renderCompatibilityHelp,
  renderGameFeatures,
  renderInstalledCopyFacts,
  renderSupportedLanguages,
  verifySystemDetails,
  type VerifiedHardwareItem,
} from "./drawer-widgets";
import {
  checkRequirement,
  ensurePcFacts,
  formatGb,
  getPcDrives,
  getPcFacts,
  pcFactsState,
  systemVerdict,
  type PcFacts,
  type RequirementCheck,
  type RequirementStatus,
  type SystemVerdict,
} from "./system-check";

/** One pending repaint per game; the callbacks all resolve with the same facts. */
const repaintQueued = new Set<string>();

function queueSystemRepaint(appName: string): void {
  if (pcFactsState() === "done" || repaintQueued.has(appName)) return;
  repaintQueued.add(appName);
  void ensurePcFacts().then(() => {
    repaintQueued.delete(appName);
    repaintSystemRequirements(appName);
  });
}

/** Store languages arrive with the requirements; keep their host separate so a
 *  tier switch does not rebuild the chips and a late answer can still fill it. */
function renderLanguageBlock(s: EpicSummary): string {
  const languages = S.loadedRequirements.get(s.appName)?.languages ?? [];
  return languages.length > 0 ? renderSupportedLanguages(languages) : "";
}

export function renderSystemTab(
  s: EpicSummary,
  partner: ThirdPartyLauncherInfo | null,
  antiCheat: string | null,
  requirementsHtml: string,
): string {
  queueSystemRepaint(s.appName);
  const g = rawOf(s.appName);
  const reqData = S.loadedRequirements.get(s.appName);
  const features = renderGameFeatures(
    s,
    g,
    partner,
    antiCheat,
    reqData,
    igdbTagsFor(s.appName),
  );
  // "The copy on this PC" only exists when there is a copy. Steam Deck,
  // ProtonDB and anti-cheat describe the game's platform, not the local files,
  // so they live in their own card and also show before installation.
  const copyCard = s.installed
    ? `
          <section class="card sys-side-card sys-copy-card">
            <h3 class="gp-section-title">${icon("layers", 14)} <span>${t("sys.thisCopy")}</span></h3>
            <div class="sys-fact-list" id="sys-copy-list">
              <div id="sys-copy-body">${renderInstalledCopyFacts(s, partner)}</div>
            </div>
          </section>`
    : "";
  const compatCard = `
          <section class="card sys-side-card" id="sys-compat-card">
            <div class="sys-side-head">
              <h3 class="gp-section-title">${icon("monitor", 14)} <span>${t("sys.compatibilityTitle")}</span></h3>
              <div class="help-tip" data-help-tip>
                <button type="button" class="help-tip-btn" data-help-btn aria-expanded="false" aria-controls="compat-help-pop" aria-label="${esc(t("sys.compatHelpTitle"))}">${icon("info", 14)}</button>
                ${renderCompatibilityHelp(s)}
              </div>
            </div>
            <div class="sys-fact-list" id="sys-compat-list">
              ${renderDeckHost(s)}${renderProtonDbHost(s)}${renderAntiCheatHost(s)}
            </div>
          </section>`;
  return `
    <div class="sys-page">
      <div class="sys-layout">
        <div class="sys-main">
          <section class="card sys-req-panel">
            <div id="sys-req-body">${requirementsHtml}</div>
          </section>
          <div class="sys-lang-host" id="sys-lang-host">${renderLanguageBlock(s)}</div>
        </div>
        <aside class="sys-side">
          ${copyCard}
          ${compatCard}
          <section class="card sys-side-card">
            <div class="sys-side-head">
              <h3 class="gp-section-title">${icon("gamepad-2", 14)} <span>${t("feat.controller")}</span></h3>
              <div class="help-tip" data-help-tip>
                <button type="button" class="help-tip-btn" data-help-btn aria-expanded="false" aria-controls="ctrl-help-pop" aria-label="${esc(t("ctrl.helpTitle"))}">${icon("info", 14)}</button>
                ${renderControllerHelp(s, g, reqData)}
              </div>
            </div>
            <div id="sys-ctrl-body">${renderControllerCard(s, g, reqData)}</div>
          </section>
          <section class="card sys-side-card">
            <h3 class="gp-section-title">${icon("sliders", 14)} <span>${t("drawer.featuresSupport")}</span></h3>
            <div class="sys-fact-list" id="hub-features-list">${features}</div>
          </section>
        </aside>
      </div>
      ${renderGameCompatCard(s)}
    </div>`;
}

/** Repaints the requirements panel and its language host after late answers. */
export function repaintSystemRequirements(appName: string): void {
  if (S.currentModalAppName !== appName || S.activeDrawerTab !== "specs") return;
  const s = summaryOf(appName);
  if (!s) return;
  const body = document.getElementById("sys-req-body");
  if (body) body.innerHTML = renderRequirementPanel(s);
  const languages = document.getElementById("sys-lang-host");
  if (languages) languages.innerHTML = renderLanguageBlock(s);
}

function verdictIcon(verdict: SystemVerdict): string {
  switch (verdict) {
    case "ok": return icon("check-circle", 14);
    case "partial": return icon("alert-triangle", 14);
    case "fail": return icon("x", 14);
    default: return icon("info", 14);
  }
}

function verdictClass(verdict: SystemVerdict): string {
  switch (verdict) {
    case "ok": return "is-ok";
    case "partial": return "is-partial";
    case "fail": return "is-fail";
    default: return "is-unknown";
  }
}

function verdictLabel(verdict: SystemVerdict): string {
  switch (verdict) {
    case "ok": return t("sys.verdictOk");
    case "partial": return t("sys.verdictPartial");
    case "fail": return t("sys.verdictFail");
    default: return t("sys.verdictUnknown");
  }
}

function statusIcon(status: RequirementStatus): string {
  switch (status) {
    case "ok": return icon("check", 11);
    case "partial": return icon("alert-triangle", 11);
    case "fail": return icon("x", 11);
    case "manual": return icon("info", 11);
    default: return icon("info", 11);
  }
}

function statusClass(status: RequirementStatus): string {
  switch (status) {
    case "ok": return "is-ok";
    case "partial": return "is-partial";
    case "fail": return "is-fail";
    case "manual": return "is-manual";
    default: return "is-unknown";
  }
}

function statusLabel(status: RequirementStatus): string {
  switch (status) {
    case "ok": return t("sys.checkOk");
    case "partial": return t("sys.checkPartial");
    case "fail": return t("sys.checkFail");
    case "manual": return t("sys.checkManual");
    default: return t("sys.checkUnknown");
  }
}

function statusChip(status: RequirementStatus): string {
  const title = status === "manual" || status === "partial"
    ? ` title="${esc(t("sys.checkNote"))}"`
    : "";
  return `<span class="sys-req-state ${statusClass(status)}"${title}>${statusIcon(status)}<span>${statusLabel(status)}</span></span>`;
}

function panelHeader(verdict: SystemVerdict | null): string {
  return `
    <div class="sys-req-head">
      <div class="sys-req-heading">
        <span class="sys-eyebrow">${icon("monitor", 12)} <span>${t("sys.pcTitle")}</span></span>
        <h2 class="sys-req-title">${t("sys.reqCardTitle")}</h2>
      </div>
      ${verdict ? `<div class="sys-verdict ${verdictClass(verdict)}">${verdictIcon(verdict)}<span>${verdictLabel(verdict)}</span></div>` : ""}
    </div>`;
}

function pcValue(facts: PcFacts): Array<{ label: string; glyph: "cpu" | "sliders" | "layers" | "monitor"; value: string }> {
  const cpuCores = facts.logicalCores > 0
    ? `${facts.physicalCores}C/${facts.logicalCores}T`
    : "";
  const vram = facts.gpuMemoryMb > 0
    ? `${formatGb(facts.gpuMemoryMb / 1024)} GB`
    : "";
  const memory = facts.memoryMb > 0 ? `${formatGb(facts.memoryMb / 1024)} GB` : "";
  return [
    { label: "CPU", glyph: "cpu", value: [facts.cpu, cpuCores].filter(Boolean).join(" · ") },
    { label: "GPU", glyph: "sliders", value: [facts.gpu, vram].filter(Boolean).join(" · ") },
    { label: "RAM", glyph: "layers", value: memory },
    { label: "OS", glyph: "monitor", value: facts.os },
  ];
}

function pcStripHtml(): string {
  if (pcFactsState() === "loading") {
    const cell = `
      <div class="sys-pc-cell">
        <span class="sys-pc-icon skel"></span>
        <div class="sys-pc-main">
          <span class="sys-pc-label">…</span>
          <span class="sys-pc-skel skel"></span>
        </div>
      </div>`;
    return `<div class="sys-pc-strip is-loading" aria-label="${esc(t("sys.pcLoading"))}">${cell.repeat(4)}</div>`;
  }
  const facts = getPcFacts();
  if (!facts) return "";
  return `
    <div class="sys-pc-strip">
      ${pcValue(facts)
        .map(
          (cell) => `
        <div class="sys-pc-cell">
          <span class="sys-pc-icon">${icon(cell.glyph, 15)}</span>
          <div class="sys-pc-main">
            <span class="sys-pc-label">${cell.label}</span>
            <span class="sys-pc-value" title="${esc(cell.value)}">${esc(cell.value || "—")}</span>
          </div>
        </div>`,
        )
        .join("")}
    </div>`;
}

function sourceActions(s: EpicSummary): string {
  const igdb = s.appName.startsWith("custom::") ? igdbGameFor(s.appName) : null;
  const customSource = s.appName.startsWith("custom::") && igdb?.url
    ? `<button class="btn ghost small" data-act="open-external-url" data-url="${esc(igdb.url)}">${icon("external", 13)} ${t("sys.openIgdb")}</button>`
    : "";
  const storeSource =
    s.appName.startsWith("riot::") ||
    s.appName.startsWith("amazon::") ||
    s.appName.startsWith("custom::")
      ? ""
      : `<button class="btn ghost small" data-act="epic-store-page" data-id="${esc(s.appName)}">${icon("external", 13)} ${t(
          s.appName.startsWith("gog::")
            ? "sys.openGogStore"
            : s.appName.startsWith("steam::")
              ? "drawer.storeTitleSteam"
              : isCompanionKey(s.appName)
                ? "ctx.storePage"
                : "sys.openEpicStore",
        )}</button>`;
  return `
    <div class="sys-req-actions">
      <button class="btn ghost small" data-act="req-refresh" data-id="${esc(s.appName)}">${icon("refresh", 13)} ${t("sys.requery")}</button>
      ${customSource || storeSource}
    </div>`;
}

function requirementRows(
  items: VerifiedHardwareItem[],
  showingMinimum: boolean,
  facts: PcFacts | null,
  installPath: string | null | undefined,
): { rows: string; checks: RequirementCheck[] } {
  const checks: RequirementCheck[] = [];
  const rows = items
    .map((item) => {
      const value = showingMinimum ? item.minimum : item.recommended;
      const check = checkRequirement(item, value, facts, installPath);
      if (check) checks.push(check);
      return `
        <div class="sys-req-row">
          <span class="sys-req-icon">${icon(item.iconName, 17)}</span>
          <div class="sys-req-main">
            <span class="sys-req-label">${esc(item.label)}</span>
            <span class="sys-req-value">${esc(value)}</span>
            ${
              check?.detected
                ? `<span class="sys-req-detected"><span>${t("sys.onThisPc")}:</span> ${esc(check.detected)}</span>`
                : ""
            }
          </div>
          ${check ? statusChip(check.status) : ""}
        </div>`;
    })
    .join("");
  return { rows, checks };
}

/**
 * The panel content only. `drawer-view` keeps the fetch trigger next to the
 * fetch itself, so this module stays presentational and free of a cycle.
 */
export function renderRequirementPanel(s: EpicSummary): string {
  queueSystemRepaint(s.appName);
  if (S.loadingReqFor.has(s.appName)) {
    return `${panelHeader(null)}<div class="sys-req-loading">${loadingState(t("sys.loadingStore"))}</div>`;
  }
  const data = S.loadedRequirements.get(s.appName);
  if (!data) {
    return `${panelHeader(null)}<div class="sys-req-loading">${loadingState(t("sys.loading"))}</div>`;
  }

  const actions = sourceActions(s);
  if (!data.supported || data.systems.length === 0) {
    return `
      ${panelHeader(null)}
      <div class="sys-req-empty">
        ${emptyPanel(
          "cpu",
          t("sys.notFoundTitle"),
          s.appName.startsWith("custom::") ? t("sys.noSource") : t("sys.notFoundDesc"),
        )}
        ${actions}
      </div>`;
  }

  const hasWin = data.systems.some((system) => isWinSys(system.systemType));
  const hasMac = data.systems.some((system) => isMacSys(system.systemType));
  const currentSystem =
    data.systems.find((system) =>
      S.activeSystemPlatform === "Windows" ? isWinSys(system.systemType) : isMacSys(system.systemType),
    ) || data.systems[0];

  const verified = verifySystemDetails(currentSystem.details);
  const minimum = verified.filter((item) => item.minimum);
  const recommended = verified.filter((item) => item.recommended);
  if (minimum.length === 0 && recommended.length === 0) {
    return `
      ${panelHeader(null)}
      <div class="sys-req-empty">
        ${emptyPanel("cpu", t("sys.notFoundTitle"), t("sys.notFoundDesc"))}
        ${actions}
      </div>`;
  }

  const hasBothTiers = minimum.length > 0 && recommended.length > 0;
  const showingMinimum = !hasBothTiers ? minimum.length > 0 : S.reqTab !== "rec";
  const activeItems = showingMinimum ? minimum : recommended;
  const facts = getPcFacts();
  const { rows, checks } = requirementRows(activeItems, showingMinimum, facts, s.installPath);
  // A table with only model names has nothing automatic to summarize; showing
  // "cannot compare" above "compare" rows would just repeat itself.
  const hasAutomatic = checks.some(
    (check) => check.status === "ok" || check.status === "partial" || check.status === "fail",
  );
  const verdict = hasAutomatic ? systemVerdict(checks) : null;
  const needsReview = checks.some(
    (check) => check.status === "manual" || check.status === "partial",
  );
  const usedScores = checks.some((check) => check.scored);

  const tierSwitch = hasBothTiers
    ? `<div class="seg sys-req-tabs">
        <button class="${showingMinimum ? "active" : ""}" data-act="req-tab" data-val="min" data-id="${esc(s.appName)}">${t("sys.minTitle")}</button>
        <button class="${!showingMinimum ? "active" : ""}" data-act="req-tab" data-val="rec" data-id="${esc(s.appName)}">${t("sys.recTitle")}</button>
      </div>`
    : `<div class="seg sys-req-tabs">
        <button class="active" disabled>${t(showingMinimum ? "sys.minTitle" : "sys.recTitle")}</button>
      </div>`;

  const platformSwitch =
    hasWin && hasMac
      ? `<div class="seg sys-req-platforms">
          <button class="${isWinSys(currentSystem.systemType) ? "active" : ""}" data-act="sys-plat" data-val="Windows">${t("sys.windowsPc")}</button>
          <button class="${isMacSys(currentSystem.systemType) ? "active" : ""}" data-act="sys-plat" data-val="Mac">${t("sys.macos")}</button>
        </div>`
      : "";

  return `
    ${panelHeader(verdict)}
    ${pcStripHtml()}
    <div class="sys-req-toolbar">
      <div class="sys-req-tier">
        <div class="sys-req-tier-row">
          ${tierSwitch}
          ${platformSwitch}
        </div>
        <span class="sys-req-hint">${t(showingMinimum ? "sys.minHint" : "sys.recHint")}</span>
      </div>
      ${actions}
    </div>
    <div class="sys-req-list">${rows}</div>
    ${
      needsReview || usedScores
        ? `<p class="sys-check-note">${icon("info", 12)} <span>${t("sys.checkNote")}</span></p>`
        : ""
    }`;
}

/**
 * The System tab's info popovers. Hover previews the note, a click pins it
 * open, and a click anywhere else closes it. Delegated, so a repaint of the
 * tab never leaves a listener behind.
 */
let pinnedHelp: HTMLElement | null = null;

function helpTipOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>("[data-help-tip]") : null;
}

function setHelpExpanded(root: HTMLElement, expanded: boolean): void {
  root.querySelector<HTMLElement>("[data-help-btn]")?.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function closeHelpTip(root: HTMLElement): void {
  root.classList.remove("is-hover", "is-pinned");
  root.removeAttribute("data-help-suppress");
  setHelpExpanded(root, false);
  if (pinnedHelp === root) pinnedHelp = null;
}

function pinHelpTip(root: HTMLElement): void {
  if (pinnedHelp && pinnedHelp !== root) closeHelpTip(pinnedHelp);
  pinnedHelp = root;
  root.classList.add("is-pinned");
  setHelpExpanded(root, true);
}

document.addEventListener("pointerover", (event) => {
  const root = helpTipOf(event.target);
  if (!root || root.hasAttribute("data-help-suppress")) return;
  root.classList.add("is-hover");
  setHelpExpanded(root, true);
  // Only one note is on screen: inspecting another tip yields the pinned one.
  if (pinnedHelp && pinnedHelp !== root) closeHelpTip(pinnedHelp);
});

document.addEventListener("pointerout", (event) => {
  const root = helpTipOf(event.target);
  if (!root) return;
  const next = event.relatedTarget;
  if (next instanceof Node && root.contains(next)) return;
  root.classList.remove("is-hover");
  root.removeAttribute("data-help-suppress");
  if (pinnedHelp !== root) setHelpExpanded(root, false);
});

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest<HTMLElement>("[data-help-btn]");
  if (button) {
    const root = button.closest<HTMLElement>("[data-help-tip]");
    if (!root) return;
    if (pinnedHelp === root) {
      const wasHovered = root.classList.contains("is-hover");
      closeHelpTip(root);
      // The pointer still rests on the button; keep it closed until it leaves.
      if (wasHovered) root.setAttribute("data-help-suppress", "1");
    } else {
      pinHelpTip(root);
    }
    return;
  }
  if (target?.closest(".help-tip-pop")) return;
  if (pinnedHelp) closeHelpTip(pinnedHelp);
});
