/**
 * Game controller (gamepad) navigation, HUD and tab switching.
 *
 * Polls the Gamepad API on the animation frame, provides spatial D-pad/analog
 * navigation, and renders the 10-foot couch HUD. State lives in S.
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
  epicRowHtml,
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

export function updateGamepadHud(active = true): void {
  const hud = ensureGamepadHud();
  if (!active || !S.gamepadPolling) {
    hud.classList.add("hidden");
    return;
  }

  hud.classList.remove("hidden");
  hud.classList.remove("dimmed");

  const modalOpen = Boolean(document.getElementById("modal-root")?.innerHTML.trim()) && Boolean(S.currentModalAppName);

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
    console.log("[Gamepad] Bağlandı:", e.gamepad.id);
    toast(t("gamepad.connected", { name: e.gamepad.id.split("(")[0].trim() }), "ok");
    if (!S.gamepadPolling) {
      S.gamepadPolling = true;
      updateGamepadHud(true);
      requestAnimationFrame(gamepadLoop);
    }
  });

  window.addEventListener("gamepaddisconnected", (e) => {
    console.log("[Gamepad] Ayrıldı:", e.gamepad.id);
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

  // Başlangıçta halihazırda bağlı oyun kolu var mı?
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

export function gamepadLoop(): void {
  if (!S.gamepadPolling) return;

  const now = performance.now();
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = Array.from(gamepads).find((g) => g !== null && g.connected);

  if (gp && now - S.lastGamepadActionTime > 170) {
    if (S.gamepadHudEl) S.gamepadHudEl.classList.remove("dimmed");
    const btns = gp.buttons;
    const axes = gp.axes;

    // D-Pad veya Sol Analog Çubuk yönleri
    const up = btns[12]?.pressed || axes[1] < -0.55;
    const down = btns[13]?.pressed || axes[1] > 0.55;
    const left = btns[14]?.pressed || axes[0] < -0.55;
    const right = btns[15]?.pressed || axes[0] > 0.55;

    // Standart Butonlar: 0: A (✕), 1: B (○), 2: X (□), 3: Y (△), 4: L1/LB, 5: R1/RB
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
      // A / Çarpı (✕): Seç / Tıkla
      S.lastGamepadActionTime = now;
      const active = document.activeElement as HTMLElement | null;
      if (active && typeof active.click === "function") {
        active.click();
      }
    } else if (btnLB || btnRB) {
      // L1/LB & R1/RB: Sekme / Filtre Değiştir
      S.lastGamepadActionTime = now;
      handleGamepadTabSwitch(btnRB ? 1 : -1);
    } else if (btnY) {
      // Y / Üçgen (△): Arama Kutusuna Odaklan
      S.lastGamepadActionTime = now;
      const searchInput = (document.getElementById("ach-search-input") || document.getElementById("search")) as HTMLInputElement | null;
      searchInput?.focus();
    } else if (btnX) {
      // X / Kare (□): Favorilere Ekle / Çıkar
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

  requestAnimationFrame(gamepadLoop);
}

export function handleGamepadDirectionalMove(dir: "up" | "down" | "left" | "right"): void {
  const modalOpen = Boolean(document.getElementById("modal-root")?.innerHTML.trim());
  const scope: HTMLElement = modalOpen
    ? document.getElementById("modal-root")!
    : (document.getElementById("view") || document.body);

  if (dir === "down" && S.view === "library" && !modalOpen) {
    const sentinel = document.getElementById("lib-scroll-sentinel");
    if (sentinel) {
      const visible = epicVisibleSummaries();
      if (S.renderedCardCount < visible.length) {
        const nextSlice = visible.slice(S.renderedCardCount, S.renderedCardCount + MORE_CARD_CHUNK);
        const startIdx = S.renderedCardCount;
        S.renderedCardCount += nextSlice.length;
        const newCardsHtml = nextSlice
          .map((s, idx) =>
            S.epicViewMode === "grid"
              ? epicCardPortrait(s, startIdx + idx)
              : epicRowHtml(s)
          )
          .join("");
        sentinel.insertAdjacentHTML("beforebegin", newCardsHtml);
        if (S.renderedCardCount >= visible.length) {
          sentinel.remove();
          S.libScrollObserver?.disconnect();
          S.libScrollObserver = null;
        }
      }
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

/** LB/RB: üst seviye konsol sekmeleri (Mağaza → Kütüphane → İndirmeler) arasında döner. */
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
