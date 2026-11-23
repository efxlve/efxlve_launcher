/**
 * The notification choreography, shared by the Settings stage and the in-game
 * toast so the preview shows exactly what the game shows.
 *
 * One choice covers the whole card: the opening and the closing belong to the
 * same animation, so there is no second "closing" setting to keep in sync.
 * Every option is a short, quiet move on the same card design.
 */

/** `minimal` rises into place, `slide` comes in from the screen edge, `soft`
 *  only fades, `pop` settles from a slight scale, `spring` has an energetic bounce,
 *  `drift` is a silky smooth glide, `drop` lands vertically from the screen edge. */
export type AchMotionStyle = "minimal" | "slide" | "soft" | "pop" | "spring" | "drift" | "drop";

export interface AchCardAnimation {
  frames: Keyframe[];
  duration: number;
  easing: string;
}

export function normalizeAchMotion(value: string | undefined): AchMotionStyle {
  return value === "slide" ||
    value === "soft" ||
    value === "pop" ||
    value === "spring" ||
    value === "drift" ||
    value === "drop"
    ? value
    : "minimal";
}

/** Cards anchored to the left edge slide in from the left, the rest from the right. */
export function achMotionDirection(position: string | undefined): 1 | -1 {
  return (position || "").trim().endsWith("left") ? -1 : 1;
}

/** Detects whether the card is bottom-anchored (+1, ascends) or top-anchored (-1, descends). */
export function achMotionVerticalDirection(position: string | undefined): 1 | -1 {
  return (position || "").trim().includes("bottom") ? 1 : -1;
}

function detectVerticalDirection(card: HTMLElement, explicitVDir?: 1 | -1): 1 | -1 {
  if (explicitVDir !== undefined) return explicitVDir;
  const parent = card.closest<HTMLElement>("[class*='pos-']");
  if (parent && parent.className.includes("bottom")) return 1;
  return -1;
}

/** The CSS media query already stops decorative motion; the JS choreography
 *  needs the same guard so a reduced-motion player gets a simple fade. */
function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function achEntryKeyframes(
  style: string,
  direction: 1 | -1 = 1,
  vDir: 1 | -1 = -1,
): AchCardAnimation {
  switch (normalizeAchMotion(style)) {
    case "slide":
      return {
        duration: 380,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        frames: [
          { opacity: 0, transform: `translateX(${direction * 28}px)` },
          { opacity: 1, transform: "translateX(0px)" },
        ],
      };
    case "soft":
      return {
        duration: 300,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
        frames: [
          { opacity: 0, transform: "scale(0.99)" },
          { opacity: 1, transform: "scale(1)" },
        ],
      };
    case "pop":
      return {
        duration: 360,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        frames: [
          { opacity: 0, transform: "scale(0.92)", offset: 0 },
          { opacity: 1, transform: "scale(1.018)", offset: 0.65 },
          { opacity: 1, transform: "scale(1)", offset: 1 },
        ],
      };
    case "spring":
      return {
        duration: 500,
        easing: "cubic-bezier(0.34, 1.4, 0.64, 1)",
        frames: [
          { opacity: 0, transform: `scale(0.88) translateY(${vDir * 10}px)`, offset: 0 },
          { opacity: 1, transform: "scale(1.025) translateY(0px)", offset: 0.62 },
          { opacity: 1, transform: "scale(0.995)", offset: 0.82 },
          { opacity: 1, transform: "scale(1)", offset: 1 },
        ],
      };
    case "drift":
      return {
        duration: 480,
        easing: "cubic-bezier(0.08, 0.92, 0.18, 1)",
        frames: [
          { opacity: 0, transform: `translateX(${direction * 36}px) scale(0.98)` },
          { opacity: 1, transform: "translateX(0px) scale(1)" },
        ],
      };
    case "drop":
      return {
        duration: 380,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        frames: [
          { opacity: 0, transform: `translateY(${vDir * 32}px) scale(0.99)` },
          { opacity: 1, transform: "translateY(0px) scale(1)" },
        ],
      };
    default:
      return {
        duration: 420,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        frames: [
          { opacity: 0, transform: "translateY(12px) scale(0.985)", offset: 0 },
          { opacity: 1, transform: "translateY(-2px) scale(1.004)", offset: 0.62 },
          { opacity: 1, transform: "translateY(0px) scale(1)", offset: 1 },
        ],
      };
  }
}

export function achExitKeyframes(
  style: string,
  direction: 1 | -1 = 1,
  vDir: 1 | -1 = -1,
): AchCardAnimation {
  switch (normalizeAchMotion(style)) {
    case "slide":
      return {
        duration: 240,
        easing: "cubic-bezier(0.4, 0, 1, 1)",
        frames: [
          { opacity: 1, transform: "translateX(0px)" },
          { opacity: 0, transform: `translateX(${direction * 24}px)` },
        ],
      };
    case "soft":
      return {
        duration: 200,
        easing: "cubic-bezier(0.4, 0, 1, 1)",
        frames: [
          { opacity: 1, transform: "scale(1)" },
          { opacity: 0, transform: "scale(0.985)" },
        ],
      };
    case "pop":
      return {
        duration: 220,
        easing: "cubic-bezier(0.4, 0, 1, 1)",
        frames: [
          { opacity: 1, transform: "scale(1)" },
          { opacity: 0, transform: "scale(0.94)" },
        ],
      };
    case "spring":
      return {
        duration: 220,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
        frames: [
          { opacity: 1, transform: "scale(1)" },
          { opacity: 0, transform: "scale(0.92)" },
        ],
      };
    case "drift":
      return {
        duration: 260,
        easing: "cubic-bezier(0.4, 0, 0.8, 1)",
        frames: [
          { opacity: 1, transform: "translateX(0px) scale(1)" },
          { opacity: 0, transform: `translateX(${direction * 28}px) scale(0.98)` },
        ],
      };
    case "drop":
      return {
        duration: 240,
        easing: "cubic-bezier(0.4, 0, 1, 1)",
        frames: [
          { opacity: 1, transform: "translateY(0px) scale(1)" },
          { opacity: 0, transform: `translateY(${vDir * 24}px) scale(0.98)` },
        ],
      };
    default:
      return {
        duration: 280,
        easing: "cubic-bezier(0.4, 0, 1, 1)",
        frames: [
          { opacity: 1, transform: "translateY(0px) scale(1)" },
          { opacity: 0, transform: "translateY(-8px) scale(0.985)" },
        ],
      };
  }
}

/** Plays the opening: the card, then the art tile and text where the style wants it. */
export function playAchCardEntry(
  card: HTMLElement,
  style = "minimal",
  direction: 1 | -1 = 1,
  vDir?: 1 | -1,
): void {
  if (typeof card.animate !== "function") return;
  card.getAnimations().forEach((animation) => animation.cancel());
  card.querySelectorAll("*").forEach((el) => {
    if (typeof el.getAnimations === "function") {
      el.getAnimations().forEach((a) => a.cancel());
    }
  });

  const motion = normalizeAchMotion(style);
  if (reducedMotion()) {
    card.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 150,
      fill: "both",
    });
    return;
  }

  const vertical = detectVerticalDirection(card, vDir);
  const entry = achEntryKeyframes(motion, direction, vertical);
  card.animate(entry.frames, {
    duration: entry.duration,
    easing: entry.easing,
    fill: "both",
  });

  // "soft", "pop", and "spring" animate the whole card organically;
  // they don't delay inner elements so nothing disappears or flickers.
  if (motion === "soft" || motion === "pop" || motion === "spring") {
    const fill = card.querySelector<HTMLElement>(".ach-hud-progress-fill");
    if (fill && typeof fill.animate === "function") {
      fill.animate(
        [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
        { duration: 400, delay: 140, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "both" },
      );
    }
    return;
  }

  const ease = "cubic-bezier(0.16, 1, 0.3, 1)";

  if (motion !== "slide" && motion !== "drift") {
    const medallion = card.querySelector<HTMLElement>(".ach-hud-medallion");
    if (medallion && typeof medallion.animate === "function") {
      medallion.animate(
        [
          { opacity: 0, transform: "scale(0.88)", offset: 0 },
          { opacity: 1, transform: "scale(1)", offset: 1 },
        ],
        {
          duration: 380,
          delay: 40,
          easing: "cubic-bezier(0.18, 1.15, 0.32, 1)",
          fill: "both",
        },
      );
    }
  }

  const tag = card.querySelector<HTMLElement>(".ach-hud-tag");
  if (tag && typeof tag.animate === "function") {
    tag.animate(
      [
        { opacity: 0, clipPath: "inset(0 100% 0 0)" },
        { opacity: 1, clipPath: "inset(0 0% 0 0)" },
      ],
      { duration: 300, delay: 80, easing: ease, fill: "both" },
    );
  }

  const title = card.querySelector<HTMLElement>(".ach-hud-title");
  if (title && typeof title.animate === "function") {
    title.animate(
      [
        { opacity: 0, transform: "translateY(5px)" },
        { opacity: 1, transform: "translateY(0px)" },
      ],
      { duration: 300, delay: 100, easing: ease, fill: "both" },
    );
  }

  const desc = card.querySelector<HTMLElement>(".ach-hud-desc");
  if (desc && typeof desc.animate === "function") {
    desc.animate(
      [
        { opacity: 0, transform: "translateY(4px)" },
        { opacity: 1, transform: "translateY(0px)" },
      ],
      { duration: 300, delay: 120, easing: ease, fill: "both" },
    );
  }

  // The progress rule draws itself from the left once the text has landed.
  const fill = card.querySelector<HTMLElement>(".ach-hud-progress-fill");
  if (fill && typeof fill.animate === "function") {
    fill.animate(
      [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
      { duration: 440, delay: 140, easing: ease, fill: "both" },
    );
  }
}

/** Plays the closing; `onDone` runs when the card is fully gone. */
export function playAchCardExit(
  card: HTMLElement,
  style = "minimal",
  direction: 1 | -1 = 1,
  onDone?: () => void,
  vDir?: 1 | -1,
): Animation | null {
  if (typeof card.animate !== "function") {
    onDone?.();
    return null;
  }
  if (reducedMotion()) {
    const animation = card.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 150,
      fill: "both",
    });
    animation.onfinish = () => onDone?.();
    return animation;
  }
  const vertical = detectVerticalDirection(card, vDir);
  const exit = achExitKeyframes(style, direction, vertical);
  const animation = card.animate(exit.frames, {
    duration: exit.duration,
    easing: exit.easing,
    fill: "both",
  });
  animation.onfinish = () => onDone?.();
  return animation;
}
