/** Designer presets and bundled wallpapers. */

import type { PresetWallpaper, ThemePreset } from "./types";

const encodeSvg = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg.trim())}`;

export const PRESET_WALLPAPERS: readonly PresetWallpaper[] = [
  {
    id: "cyber-grid",
    nameKey: "settings.themeWpCyberGrid",
    defaultName: "Cyber Grid",
    dataUrl: encodeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
      <defs>
        <linearGradient id="cg-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#05050d"/>
          <stop offset="55%" stop-color="#0d081f"/>
          <stop offset="100%" stop-color="#2a0845"/>
        </linearGradient>
        <linearGradient id="cg-glow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ff007f" stop-opacity="0.6"/>
          <stop offset="100%" stop-color="#7928ca" stop-opacity="0"/>
        </linearGradient>
        <pattern id="cg-grid" width="60" height="60" patternUnits="userSpaceOnUse">
          <path d="M 60 0 L 0 0 0 60" fill="none" stroke="#00f0ff" stroke-width="1" stroke-opacity="0.18"/>
        </pattern>
      </defs>
      <rect width="1920" height="1080" fill="url(#cg-sky)"/>
      <rect y="480" width="1920" height="600" fill="url(#cg-glow)"/>
      <rect y="500" width="1920" height="580" fill="url(#cg-grid)"/>
      <line x1="0" y1="500" x2="1920" y2="500" stroke="#ff007f" stroke-width="2" stroke-opacity="0.8"/>
    </svg>`),
  },
  {
    id: "deep-nebula",
    nameKey: "settings.themeWpDeepNebula",
    defaultName: "Deep Space",
    dataUrl: encodeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
      <defs>
        <radialGradient id="nb-g1" cx="30%" cy="40%" r="55%">
          <stop offset="0%" stop-color="#4f1787" stop-opacity="0.55"/>
          <stop offset="50%" stop-color="#180161" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="#05030a" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="nb-g2" cx="75%" cy="65%" r="50%">
          <stop offset="0%" stop-color="#005792" stop-opacity="0.45"/>
          <stop offset="60%" stop-color="#0b1b3d" stop-opacity="0.2"/>
          <stop offset="100%" stop-color="#05030a" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="1920" height="1080" fill="#06060c"/>
      <rect width="1920" height="1080" fill="url(#nb-g1)"/>
      <rect width="1920" height="1080" fill="url(#nb-g2)"/>
      <circle cx="240" cy="180" r="1.5" fill="#fff" opacity="0.8"/>
      <circle cx="850" cy="120" r="1.2" fill="#fff" opacity="0.6"/>
      <circle cx="1400" cy="220" r="1.8" fill="#a5f3fc" opacity="0.9"/>
      <circle cx="1680" cy="450" r="1.3" fill="#fff" opacity="0.7"/>
      <circle cx="420" cy="620" r="1.4" fill="#fbcfe8" opacity="0.8"/>
      <circle cx="1100" cy="740" r="1.6" fill="#fff" opacity="0.7"/>
    </svg>`),
  },
  {
    id: "cyber-blades",
    nameKey: "settings.themeWpCyberBlades",
    defaultName: "Cyber Blades",
    dataUrl: encodeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
      <defs>
        <linearGradient id="b-g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0b0d12"/>
          <stop offset="100%" stop-color="#171b24"/>
        </linearGradient>
        <linearGradient id="b-acc" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.7"/>
          <stop offset="100%" stop-color="#ef4444" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <rect width="1920" height="1080" fill="#08090d"/>
      <polygon points="0,0 900,0 600,1080 0,1080" fill="url(#b-g1)"/>
      <polygon points="898,0 904,0 604,1080 598,1080" fill="url(#b-acc)"/>
      <polygon points="1200,0 1920,0 1920,1080 1500,1080" fill="#0d1017"/>
      <polygon points="1198,0 1202,0 1502,1080 1498,1080" fill="#3b82f6" opacity="0.3"/>
    </svg>`),
  },
  {
    id: "aurora-emerald",
    nameKey: "settings.themeWpAuroraEmerald",
    defaultName: "Aurora Emerald",
    dataUrl: encodeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
      <defs>
        <radialGradient id="au-1" cx="40%" cy="30%" r="60%">
          <stop offset="0%" stop-color="#059669" stop-opacity="0.35"/>
          <stop offset="50%" stop-color="#047857" stop-opacity="0.15"/>
          <stop offset="100%" stop-color="#021f16" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="au-2" cx="70%" cy="45%" r="55%">
          <stop offset="0%" stop-color="#10b981" stop-opacity="0.25"/>
          <stop offset="60%" stop-color="#064e3b" stop-opacity="0.08"/>
          <stop offset="100%" stop-color="#021f16" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="1920" height="1080" fill="#040b08"/>
      <rect width="1920" height="1080" fill="url(#au-1)"/>
      <rect width="1920" height="1080" fill="url(#au-2)"/>
    </svg>`),
  },
  {
    id: "sakura-dusk",
    nameKey: "settings.themeWpSakuraDusk",
    defaultName: "Sakura Dusk",
    dataUrl: encodeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
      <defs>
        <radialGradient id="sk-1" cx="50%" cy="35%" r="65%">
          <stop offset="0%" stop-color="#db2777" stop-opacity="0.3"/>
          <stop offset="60%" stop-color="#4c0519" stop-opacity="0.1"/>
          <stop offset="100%" stop-color="#0d0408" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="sk-2" cx="20%" cy="70%" r="50%">
          <stop offset="0%" stop-color="#7c3aed" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="#0d0408" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="1920" height="1080" fill="#0d060a"/>
      <rect width="1920" height="1080" fill="url(#sk-1)"/>
      <rect width="1920" height="1080" fill="url(#sk-2)"/>
    </svg>`),
  },
  {
    id: "fluid-waves",
    nameKey: "settings.themeWpFluidWaves",
    defaultName: "Fluid Waves",
    dataUrl: encodeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
      <defs>
        <linearGradient id="fw-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#1e1e28"/>
          <stop offset="100%" stop-color="#0e0e14"/>
        </linearGradient>
      </defs>
      <rect width="1920" height="1080" fill="#0b0b10"/>
      <path d="M0,600 C400,450 800,750 1200,550 C1600,350 1800,600 1920,520 L1920,1080 L0,1080 Z" fill="url(#fw-g)" opacity="0.65"/>
      <path d="M0,720 C500,580 900,850 1400,660 C1700,550 1850,700 1920,640 L1920,1080 L0,1080 Z" fill="#14141c" opacity="0.75"/>
    </svg>`),
  },
  {
    id: "sunset-horizon",
    nameKey: "settings.themeWpSunsetHorizon",
    defaultName: "Sunset Horizon",
    dataUrl: encodeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
      <defs>
        <linearGradient id="sh-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0a0505"/>
          <stop offset="60%" stop-color="#240c0c"/>
          <stop offset="90%" stop-color="#5a1e06"/>
          <stop offset="100%" stop-color="#b45309"/>
        </linearGradient>
      </defs>
      <rect width="1920" height="1080" fill="url(#sh-sky)"/>
      <polygon points="0,1080 300,740 600,860 900,680 1200,800 1500,650 1920,780 1920,1080" fill="#1a0b06" opacity="0.85"/>
      <polygon points="0,1080 200,840 500,920 850,810 1150,910 1400,800 1750,890 1920,830 1920,1080" fill="#0c0502"/>
    </svg>`),
  },
  {
    id: "carbon-fiber",
    nameKey: "settings.themeWpCarbonFiber",
    defaultName: "Carbon Fiber",
    dataUrl: encodeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
      <defs>
        <pattern id="cf-p" width="12" height="12" patternUnits="userSpaceOnUse">
          <rect width="12" height="12" fill="#0d0e12"/>
          <polygon points="0,0 6,0 0,6" fill="#171920"/>
          <polygon points="6,6 12,6 6,12" fill="#171920"/>
          <polygon points="6,0 12,0 12,6" fill="#13141a"/>
          <polygon points="0,6 6,6 0,12" fill="#13141a"/>
        </pattern>
      </defs>
      <rect width="1920" height="1080" fill="url(#cf-p)"/>
    </svg>`),
  },
];

export const THEME_PRESETS: readonly ThemePreset[] = [
  { id: "cyberpunk", name: "Cyberpunk", bg: "#07080a", surface: "#12151b", accent: "#fcee0a", light: false },
  { id: "tokyonight", name: "Tokyo Night", bg: "#16161e", surface: "#212337", accent: "#7aa2f7", light: false },
  { id: "dracula", name: "Dracula", bg: "#282a36", surface: "#2d303e", accent: "#bd93f9", light: false },
  { id: "catppuccin", name: "Catppuccin", bg: "#1e1e2e", surface: "#313244", accent: "#cba6f7", light: false },
  { id: "emerald", name: "Emerald Matrix", bg: "#08100d", surface: "#142620", accent: "#10b981", light: false },
  { id: "synthwave", name: "Synthwave '84", bg: "#13111c", surface: "#241d3b", accent: "#ff2a85", light: false },
  { id: "rosepine", name: "Rosé Pine", bg: "#191724", surface: "#26233a", accent: "#eb6f92", light: false },
  { id: "sunset", name: "Sunset Amber", bg: "#100d0a", surface: "#231c15", accent: "#f59e0b", light: false },
  { id: "nord", name: "Nordic Slate", bg: "#242933", surface: "#3b4252", accent: "#88c0d0", light: false },
  { id: "oledcyan", name: "Abyss Cyan", bg: "#000000", surface: "#0e151c", accent: "#00f0ff", light: false },
  { id: "quarantine", name: "Quarantine Protocol", bg: "#080a0c", surface: "#171b22", accent: "#dc2626", light: false },
  { id: "sentience", name: "Synthetic Soul", bg: "#080c14", surface: "#151e2e", accent: "#00a2ff", light: false },
  { id: "sanctum", name: "Ashen Sanctum", bg: "#0b0a08", surface: "#1f1c17", accent: "#e5a93c", light: false },
  { id: "resonance", name: "Resonance Core", bg: "#0b0c0e", surface: "#1a1f26", accent: "#f97316", light: false },
  { id: "homestead", name: "Autumn Homestead", bg: "#0c140d", surface: "#18261b", accent: "#eab308", light: false },
  { id: "white", name: "Pure White", bg: "#f3f4f6", surface: "#ffffff", accent: "#111318", light: true },
];

