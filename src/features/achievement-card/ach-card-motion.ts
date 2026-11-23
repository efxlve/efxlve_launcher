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

function buildSpringFrames(vDir: 1 | -1): Keyframe[] {
  const steps = 14;
  const damping = 5.2;
  const freq = 10.5;
  const frames: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const env = Math.exp(-damping * t);
    const osc = Math.cos(freq * t);
    const val = 1 - env * osc;
    const scale = Number((0.86 + val * 0.14).toFixed(4));
    const y = Number(((1 - val) * 14 * vDir).toFixed(2));
    const opacity = Number(Math.min(1, t < 0.15 ? t / 0.15 : 1).toFixed(3));
    frames.push({
      offset: Number(t.toFixed(3)),
      opacity,
      transform: `translateY(${y}px) scale(${scale})`,
    });
  }
  frames[frames.length - 1] = {
    offset: 1,
    opacity: 1,
    transform: "translateY(0px) scale(1)",
  };
  return frames;
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
        duration: 440,
        easing: "cubic-bezier(0.2, 1.55, 0.35, 1.0)",
        frames: [
          { opacity: 0, transform: "scale(0.86)" },
          { opacity: 1, transform: "scale(1)" },
        ],
      };
    case "spring":
      return {
        duration: 560,
        easing: "linear",
        frames: buildSpringFrames(vDir),
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
        duration: 240,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
        frames: [
          { opacity: 1, transform: "translateY(0px) scale(1)" },
          { opacity: 0, transform: `translateY(${vDir * 10}px) scale(0.92)` },
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

  // "soft" is the quiet option: the card fades as one piece, no inner element shift.
  if (motion === "soft") {
    const fill = card.querySelector<HTMLElement>(".ach-hud-progress-fill");
    if (fill && typeof fill.animate === "function") {
      fill.animate(
        [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
        { duration: 400, delay: 100, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "both" },
      );
    }
    return;
  }

  const ease = "cubic-bezier(0.16, 1, 0.3, 1)";

  if (motion !== "slide" && motion !== "drift") {
    const medallion = card.querySelector<HTMLElement>(".ach-hud-medallion");
    if (medallion && typeof medallion.animate === "function") {
      const medEasing =
        motion === "spring"
          ? "cubic-bezier(0.34, 1.3, 0.64, 1)"
          : motion === "pop"
            ? "cubic-bezier(0.2, 1.55, 0.35, 1.0)"
            : "cubic-bezier(0.18, 1.15, 0.32, 1)";
      const medDuration = motion === "spring" ? 480 : motion === "pop" ? 440 : 380;
      medallion.animate(
        [
          { opacity: 0, transform: "scale(0.85)", offset: 0 },
          { opacity: 1, transform: "scale(1)", offset: 1 },
        ],
        {
          duration: medDuration,
          delay: 40,
          easing: medEasing,
          fill: "both",
        },
      );
    }
  }

  // In "pop", the card scales up as one cohesive unit; shifting text lines with
  // separate delays or transforms causes text to drift out of sync and snap when
  // inner animations end.
  if (motion !== "pop") {
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
  }

  // The progress rule draws itself from the left once the text has landed.
  const fill = card.querySelector<HTMLElement>(".ach-hud-progress-fill");
  if (fill && typeof fill.animate === "function") {
    fill.animate(
      [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
      { duration: 440, delay: motion === "pop" ? 100 : 140, easing: ease, fill: "both" },
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
