/**
 * Top navigation helpers: active-tab indicator, download badge and account chip.
 *
 * These are shared by several features (downloads, collections, library) and by
 * `main.ts`, so they live in `core`.
 */

import { CircleUserRound, createIcons } from "lucide";
import { dlBadge } from "./dom";
import { S } from "./state";
import { esc } from "./utils";
import { t } from "../i18n";

/** Position the sliding underline under the active nav tab. */
export function updateNavIndicator(): void {
  const bar = document.getElementById("titlebar");
  const seg = document.getElementById("nav-seg");
  const ind = document.getElementById("nav-indicator");
  if (!bar || !seg || !ind) return;
  const active = seg.querySelector<HTMLElement>(".nav-tab.active");
  if (!active) {
    ind.style.opacity = "0";
    return;
  }
  if (!S.navIndicatorReady) {
    // Skip the slide animation on first placement (avoid sliding from width 0).
    ind.style.transition = "none";
    S.navIndicatorReady = true;
    window.setTimeout(() => { ind.style.transition = ""; }, 80);
  }
  const barRect = bar.getBoundingClientRect();
  const tabRect = active.getBoundingClientRect();
  ind.style.width = `${tabRect.width}px`;
  ind.style.transform = `translateX(${tabRect.left - barRect.left}px)`;
  ind.style.opacity = "1";
}

/** Refresh the download counter badge and re-align the nav indicator. */
export function updateBadge(): void {
  const active = [...S.downloads.values()].filter((d) => !d.done).length;
  dlBadge.textContent = active > 0 ? String(active) : "";
  dlBadge.classList.toggle("hidden", active === 0);
  // The badge is inline, so the tab width changes; re-align the sliding indicator.
  updateNavIndicator();
}

/** Reflect the offline-mode state on the top-bar network chip. */
export function updateOfflineModeUi(): void {
  const btn = document.getElementById("btn-offline-mode");
  if (!btn) return;
  btn.classList.toggle("offline", S.offlineMode);
  btn.classList.toggle("online", !S.offlineMode);
  const label = btn.querySelector<HTMLElement>(".net-label");
  if (label) label.textContent = S.offlineMode ? t("nav.offline") : t("nav.online");
  btn.title = S.offlineMode ? t("nav.offlineTip") : t("nav.onlineTip");
}

/** Refresh the account chip in the top bar. */
export function updateChrome(): void {
  const acc = document.getElementById("account");
  if (acc) {
    const name = S.epicAccount || t("nav.notLoggedIn");
    if (acc.dataset.acct !== (S.epicAccount || "")) {
      acc.dataset.acct = S.epicAccount || "";
      if (S.epicAccount) {
        const initial = (S.epicAccount.trim()[0] || "?").toUpperCase();
        acc.innerHTML =
          `<span class="account-avatar"><span class="avatar-initial">${esc(initial)}</span></span>` +
          `<span class="account-name">${esc(name)}</span>`;
      } else {
        acc.innerHTML =
          `<span class="account-avatar"><i data-lucide="circle-user-round"></i></span>` +
          `<span class="account-name">${t("nav.notLoggedIn")}</span>`;
        createIcons({ icons: { CircleUserRound } });
      }
    }
    acc.classList.toggle("logged", !!S.epicAccount);
    acc.title = S.epicAccount
      ? t("nav.profileTip", { name })
      : t("nav.loginTip");
  }
}
