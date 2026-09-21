/**
 * Demo catalog actions used when running without Tauri (browser `vite dev`).
 *
 * These mirror the real Rust-backed actions with an in-memory/localStorage
 * simulation so the UI can be exercised without the backend.
 */

import { invoke } from "@tauri-apps/api/core";
import { fetchGames, isTauri, mockInstalled, saveMockInstalled } from "./constants";
import { closeModal } from "./dom";
import { updateBadge } from "./nav";
import { render } from "./render";
import { S } from "./state";
import { toast } from "./toast";
import type { Game } from "./types";

/** Look up a demo game by id. */
export function gameById(id: string): Game | undefined {
  return S.games.find((g) => g.id === id);
}

/** Reload the demo game list. */
export async function refreshGames(): Promise<void> {
  try {
    S.games = await fetchGames();
  } catch (e) {
    toast(`Oyun listesi alınamadı: ${String(e)}`, "err");
  }
  render();
}

/** Simulate (or trigger) a demo game installation. */
export async function installGame(id: string): Promise<void> {
  const game = gameById(id);
  if (!game || game.installed || S.downloads.get(id)?.done === false) return;
  S.downloads.set(id, { progress: 0, done: false, title: game.title });
  updateBadge();
  render();

  try {
    if (isTauri) {
      const msg = await invoke<string>("install_game", { id });
      toast(msg, "ok");
    } else {
      for (let p = 5; p <= 100; p += 5) {
        await new Promise((r) => setTimeout(r, 90));
        S.downloads.set(id, { progress: p, done: false, title: game.title });
        if (S.view === "downloads" || S.view === "library") render();
        updateBadge();
      }
      S.downloads.set(id, { progress: 100, done: true, title: game.title });
      const set = mockInstalled();
      set.add(id);
      saveMockInstalled(set);
      toast(`${game.title} kuruldu`, "ok");
    }
  } catch (e) {
    S.downloads.delete(id);
    toast(`Kurulum başarısız: ${String(e)}`, "err");
  }
  await refreshGames();
}

/** Simulate (or trigger) a demo game launch. */
export async function launchGame(id: string): Promise<void> {
  try {
    if (isTauri) {
      const msg = await invoke<string>("launch_game", { id });
      toast(msg, "ok");
    } else {
      toast(`${gameById(id)?.title ?? id} başlatılıyor… (demo modu)`, "ok");
    }
  } catch (e) {
    toast(String(e), "err");
  }
}

/** Simulate (or trigger) a demo game uninstall. */
export async function uninstallGame(id: string): Promise<void> {
  try {
    if (isTauri) {
      const msg = await invoke<string>("uninstall_game", { id });
      toast(msg, "ok");
    } else {
      const set = mockInstalled();
      set.delete(id);
      saveMockInstalled(set);
      toast(`${gameById(id)?.title ?? id} kaldırıldı`, "ok");
    }
  } catch (e) {
    toast(String(e), "err");
  }
  closeModal();
  await refreshGames();
}
