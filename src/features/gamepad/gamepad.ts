/**
 * Game controller (gamepad) polling, HUD and navigation.
 *
 * Polls the Gamepad API only while a controller is connected (80ms when idle).
 * On the desktop UI it uses spatial D-pad navigation. State lives in S.
 */

import { MORE_CARD_CHUNK } from "../../core/constants";
import { closeModal } from "../../core/dom";
import { toggleFav } from "../../core/game-view";
import { openEpicModal, render } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { t } from "../../i18n";
import type { DrawerTab } from "../../core/types";
import {
  epicCardPortrait,
  epicVisibleSummaries,
} from "../library/library-view";
import { closeScreenshotLightbox, navigateScreenshotLightbox } from "../screenshots/screenshots-view";
import { setView } from "../store/store-view";
export function ensureGamepadHud(): HTMLElement {
  if (!S.gamepadHudEl) {
    S.gamepadHudEl = document.getElementById("gamepad-hud-bar");
    if (!S.gamepadHudEl) {
      S.gamepadHudEl = document.createElement("div");
      S.gamepadHudEl.id = "gamepad-hud-bar";
      S.gamepadHudEl.className = "gamepad-hud-bar hidden";
      document.body.appendChild(S.gamepadHudEl);
    }
  }
  return S.gamepadHudEl;
}

let lastHudKey = "";

export function updateGamepadHud(active = true): void {
  const hud = ensureGamepadHud();
  if (!active || !S.gamepadPolling) {
    hud.classList.add("hidden");
    return;
  }

  hud.classList.remove("hidden");
  hud.classList.remove("dimmed");

  const modalOpen = Boolean(document.getElementById("modal-root")?.innerHTML.trim()) && Boolean(S.currentModalAppName);

  // Skip rebuilding the HUD markup when nothing that affects it changed.
  const hudKey = `${modalOpen ? "modal" : S.view}|${S.appLanguage}`;
  if (hudKey === lastHudKey) return;
  lastHudKey = hudKey;

  if (modalOpen) {
    hud.innerHTML = `
      <div class="gp-hud-item"><span class="gp-glyph btn-a">A</span> <span>${t("gamepad.select")}</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-b">B</span> <span>${t("common.back")}</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-x">X</span> <span>${t("gamepad.favorite")}</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-bumper">LB</span><span class="gp-glyph btn-bumper">RB</span> <span>${t("gamepad.tabs")}</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-dpad">D-Pad</span> <span>${t("gamepad.navigate")}</span></div>
    `;
  } else if (S.view === "profile") {
    hud.innerHTML = `
      <div class="gp-hud-item"><span class="gp-glyph btn-a">A</span> <span>${t("gamepad.inspectTrophies")}</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-x">X</span> <span>${t("profile.refresh")}</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-y">Y</span> <span>${t("common.search")}</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-bumper">LB</span><span class="gp-glyph btn-bumper">RB</span> <span>${t("gamepad.tabs")}</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-dpad">D-Pad</span> <span>${t("gamepad.navigate")}</span></div>
    `;
  } else {
    hud.innerHTML = `
      <div class="gp-hud-item"><span class="gp-glyph btn-a">A</span> <span>${t("gamepad.detail")}</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-x">X</span> <span>${t("gamepad.favorite")}</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-y">Y</span> <span>${t("common.search")}</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-bumper">LB</span><span class="gp-glyph btn-bumper">RB</span> <span>${t("gamepad.tabs")}</span></div>
      <div class="gp-hud-item"><span class="gp-glyph btn-dpad">D-Pad</span> <span>${t("gamepad.navigate")}</span></div>
    `;
  }
}

export function initGamepadSupport(): void {
  window.addEventListener("gamepadconnected", (e) => {
    const name = e.gamepad.id.split("(")[0].trim();
    toast(t("gamepad.connected", { name }), "ok");
    if (!S.gamepadPolling) {
      S.gamepadPolling = true;
      updateGamepadHud(true);
      requestAnimationFrame(gamepadLoop);
    }
  });

  window.addEventListener("gamepaddisconnected", (e) => {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const hasAny = Array.from(gamepads).some((g) => g !== null && g.connected);
    if (!hasAny) {
      S.gamepadPolling = false;
      updateGamepadHud(false);
    }
  });

  window.addEventListener("mousemove", () => {
    if (S.gamepadHudEl && !S.gamepadHudEl.classList.contains("hidden")) {
      S.gamepadHudEl.classList.add("dimmed");
    }
  }, { passive: true });

  // Is a controller already connected at startup?
  setTimeout(() => {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (Array.from(gamepads).some((g) => g !== null && g.connected)) {
      if (!S.gamepadPolling) {
        S.gamepadPolling = true;
        updateGamepadHud(true);
        requestAnimationFrame(gamepadLoop);
      }
    }
  }, 1000);
}

function gamepadHasActivity(gp: Gamepad): boolean {
  for (const b of gp.buttons) {
    if (b.pressed) return true;
  }
  return Math.abs(gp.axes[0] ?? 0) > 0.55 || Math.abs(gp.axes[1] ?? 0) > 0.55;
}

function scheduleGamepadLoop(idle: boolean): void {
  if (!S.gamepadPolling) return;
  if (idle) {
    window.setTimeout(() => {
      if (S.gamepadPolling) requestAnimationFrame(gamepadLoop);
    }, 80);
    return;
  }
  requestAnimationFrame(gamepadLoop);
}

export function gamepadLoop(): void {
  if (!S.gamepadPolling) return;

  const now = performance.now();
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = Array.from(gamepads).find((g) => g !== null && g.connected);
  if (!gp) {
    scheduleGamepadLoop(true);
    return;
  }

  const idle = !gamepadHasActivity(gp);
  if (idle) {
    scheduleGamepadLoop(true);
    return;
  }

  if (now - S.lastGamepadActionTime > 170) {
    if (S.gamepadHudEl) S.gamepadHudEl.classList.remove("dimmed");
    const btns = gp.buttons;
    const axes = gp.axes;

    // D-Pad or left analog stick directions
    const up = btns[12]?.pressed || axes[1] < -0.55;
    const down = btns[13]?.pressed || axes[1] > 0.55;
    const left = btns[14]?.pressed || axes[0] < -0.55;
    const right = btns[15]?.pressed || axes[0] > 0.55;

    // Face buttons: 0: A, 1: B, 2: X, 3: Y, 4: LB, 5: RB
    const btnA = btns[0]?.pressed;
    const btnB = btns[1]?.pressed;
    const btnX = btns[2]?.pressed;
    const btnY = btns[3]?.pressed;
    const btnLB = btns[4]?.pressed;
    const btnRB = btns[5]?.pressed;

    if (btnB) {
      // B / Daire (○): Geri / Kapat
      S.lastGamepadActionTime = now;
      if (S.activeLightboxScreenshot) {
        closeScreenshotLightbox();
      } else if (S.currentModalAppName) {
        closeModal();
      } else if (S.view === "store") {
        setView(S.lastNonStoreView);
        render();
      }
    } else if (btnA) {
      // A / Cross: Select / Click
      S.lastGamepadActionTime = now;
      const active = document.activeElement as HTMLElement | null;
      if (active && typeof active.click === "function") {
        active.click();
      }
    } else if (btnLB || btnRB) {
      // L1/LB & R1/RB: switch tab / filter
          S.lastGamepadActionTime = now;
      handleGamepadTabSwitch(btnRB ? 1 : -1);
    } else if (btnY) {
      // Y / Triangle: focus the search box
      S.lastGamepadActionTime = now;
      const searchInput = (document.getElementById("ach-search-input") || document.getElementById("search")) as HTMLInputElement | null;
      searchInput?.focus();
    } else if (btnX) {
      // X / Square: add / remove favorite
      S.lastGamepadActionTime = now;
      if (S.currentModalAppName) {
        toggleFav(S.currentModalAppName);
      }
    } else if (up || down || left || right) {
      S.lastGamepadActionTime = now;
      if (S.activeLightboxScreenshot && (left || right)) {
        navigateScreenshotLightbox(left ? "prev" : "next");
      } else {
        handleGamepadDirectionalMove(up ? "up" : down ? "down" : left ? "left" : "right");
      }
    }
  }

  scheduleGamepadLoop(false);
}

function libraryGridColumns(grid: HTMLElement): number {
  const card = grid.querySelector<HTMLElement>(":scope > .pcard");
  if (!card) return 1;
  const gap = 20;
  const w = card.offsetWidth;
  if (w <= 0) return 1;
  return Math.max(1, Math.round((grid.clientWidth + gap) / (w + gap)));
}

function moveLibraryGridFocus(dir: "up" | "down" | "left" | "right"): boolean {
  const grid = document.querySelector<HTMLElement>(".pgrid");
  if (!grid) return false;
  const cards = Array.from(grid.querySelectorAll<HTMLElement>(":scope > .pcard"));
  if (cards.length === 0) return false;

  const current = document.activeElement as HTMLElement | null;
  const onCard = current && current.classList.contains("pcard") && grid.contains(current);
  const filters = Array.from(document.querySelectorAll<HTMLElement>(".lib-filter, .lib-sort-btn, .lib-search input, .lib-refresh-btn"));

  if (!onCard) {
    if (dir === "down" || dir === "right") {
      cards[0].focus();
      cards[0].scrollIntoView({ block: "nearest", inline: "nearest" });
      return true;
    }
    return false;
  }

  const idx = cards.indexOf(current);
  if (idx < 0) return false;
  const cols = libraryGridColumns(grid);
  let next = idx;
  if (dir === "left") next = idx - 1;
  else if (dir === "right") next = idx + 1;
  else if (dir === "up") next = idx - cols;
  else next = idx + cols;

  if (dir === "up" && next < 0) {
    const lastFilter = filters[filters.length - 1];
    if (lastFilter) {
      lastFilter.focus();
      return true;
    }
    return true;
  }
  if (next < 0 || next >= cards.length) return true;
  cards[next].focus();
  cards[next].scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

export function handleGamepadDirectionalMove(dir: "up" | "down" | "left" | "right"): void {
  const modalOpen = Boolean(document.getElementById("modal-root")?.innerHTML.trim());
  const scope: HTMLElement = modalOpen
    ? document.getElementById("modal-root")!
    : (document.getElementById("view") || document.body);

  if (S.view === "library" && !modalOpen) {
    if (moveLibraryGridFocus(dir)) {
      if (dir === "down") {
        const sentinel = document.getElementById("lib-scroll-sentinel");
        if (sentinel) {
          const visible = epicVisibleSummaries();
          if (S.renderedCardCount < visible.length) {
            const nextSlice = visible.slice(S.renderedCardCount, S.renderedCardCount + MORE_CARD_CHUNK);
            S.renderedCardCount += nextSlice.length;
            sentinel.insertAdjacentHTML("beforebegin", nextSlice.map((s) => epicCardPortrait(s)).join(""));
            if (S.renderedCardCount >= visible.length) {
              sentinel.remove();
              S.libScrollObserver?.disconnect();
              S.libScrollObserver = null;
            }
          }
        }
      }
      return;
    }
    const chrome = Array.from(
      document.querySelectorAll<HTMLElement>(".lib-filter, .lib-sort-btn, .lib-search input, .lib-refresh-btn"),
    ).filter((el) => el.offsetParent !== null);
    if (chrome.length > 0) {
      const current = document.activeElement as HTMLElement | null;
      const idx = current ? chrome.indexOf(current) : -1;
      const next = dir === "left" || dir === "up"
        ? (idx <= 0 ? chrome.length - 1 : idx - 1)
        : (idx < 0 || idx >= chrome.length - 1 ? 0 : idx + 1);
      chrome[next].focus();
      return;
    }
  }

  const selector = 'button:not([disabled]):not(.iconbtn), .pcard, [tabindex="0"], a[href], input:not([disabled]), select:not([disabled])';
  const focusables = Array.from(scope.querySelectorAll<HTMLElement>(selector)).filter((el) => {
    return el.offsetParent !== null;
  });

  if (focusables.length === 0) return;

  const current = document.activeElement as HTMLElement | null;
  if (!current || !scope.contains(current) || current === document.body) {
    const primaryBtn = scope.querySelector<HTMLElement>(".btn.play, .btn.primary, .pcard");
    if (primaryBtn) {
      primaryBtn.focus();
    } else {
      focusables[0].focus();
    }
    return;
  }

  const curRect = current.getBoundingClientRect();
  const curCenter = { x: curRect.left + curRect.width / 2, y: curRect.top + curRect.height / 2 };

  let bestCandidate: HTMLElement | null = null;
  let minDistance = Infinity;

  for (const el of focusables) {
    if (el === current) continue;
    const r = el.getBoundingClientRect();
    const center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };

    const dx = center.x - curCenter.x;
    const dy = center.y - curCenter.y;

    if (dir === "up" && dy >= -4) continue;
    if (dir === "down" && dy <= 4) continue;
    if (dir === "left" && dx >= -4) continue;
    if (dir === "right" && dx <= 4) continue;

    let dist = 0;
    if (dir === "up" || dir === "down") {
      dist = Math.abs(dy) + Math.abs(dx) * 1.8;
    } else {
      dist = Math.abs(dx) + Math.abs(dy) * 1.8;
    }

    if (dist < minDistance) {
      minDistance = dist;
      bestCandidate = el;
    }
  }

  if (bestCandidate) {
    bestCandidate.focus();
    bestCandidate.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }
}

/** LB/RB: cycles the top-level console tabs (Store → Library → Downloads). */
export function cycleTopView(step: number): void {
  const order = ['[data-act="open-store"]', '[data-view="library"]', '[data-view="downloads"]'];
  const current = S.view === "store" ? 0 : S.view === "downloads" ? 2 : 1;
  const next = (current + step + order.length) % order.length;
  document.querySelector<HTMLElement>(`#nav ${order[next]}`)?.click();
}

export function handleGamepadTabSwitch(step: number): void {
  if (S.currentModalAppName) {
    const tabs: DrawerTab[] = ["overview", "achievements", "dlcs", "screenshots"];
    const curSummary = S.epicSummaries.find((x) => x.appName === S.currentModalAppName);
    if (curSummary?.installed) tabs.push("manage");
    tabs.push("specs");

    const curIdx = tabs.indexOf(S.activeDrawerTab);
    const nextIdx = (curIdx + step + tabs.length) % tabs.length;
    S.activeDrawerTab = tabs[nextIdx];
    openEpicModal(S.currentModalAppName, false, true);
  } else {
    cycleTopView(step);
  }
  updateGamepadHud(S.gamepadPolling);
}
