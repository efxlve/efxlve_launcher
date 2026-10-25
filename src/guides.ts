/**
 * Third-party written-guide lookups.
 *
 * PowerPyx publishes a normal WordPress search page and public trophy-guide
 * pages. The backend keeps only the roadmap facts and the link; the guide body
 * stays on the site.
 */

import { invoke } from "@tauri-apps/api/core";

export interface PowerPyxGuide {
  supported: boolean;
  title: string;
  url: string;
  difficulty: string;
  time: string;
  missables: string;
}

export const powerpyxGameGuide = (title: string) =>
  invoke<PowerPyxGuide>("powerpyx_game_guide", { title });
