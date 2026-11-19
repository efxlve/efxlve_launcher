/**
 * The notification choreography, shared by the Settings stage and the in-game
 * toast so the preview shows exactly what the game shows.
 *
 * One choice covers the whole card: the opening and the closing belong to the
 * same animation, so there is no second "closing" setting to keep in sync.
 * Every option is a short, quiet move on the same card design.
 */

/** `minimal` rises into place, `slide` comes in from the screen edge, `soft`
 *  only fades, `pop` settles from a slight scale. */
export type AchMotionStyle = "minimal" | "slide" | "soft" | "pop";

export interface AchCardAnimation {
  frames: Keyframe[];
  duration: number;
  easing: string;
}

export function normalizeAchMotion(value: string | undefined): AchMotionStyle {
  return value === "slide" || value === "soft" || value === "pop" ? value : "minimal";
}

/** Cards anchored to the left edge slide in from the left, the rest from the right. */
export function achMotionDirection(position: string | undefined): 1 | -1 {
  return (position || "").trim().endsWith("left") ? -1 : 1;
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

export function achEntryKeyframes(style: string, direction: 1 | -1 = 1): AchCardAnimation {
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
        duration: 400,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        frames: [
          { opacity: 0, transform: "scale(0.92)", offset: 0 },
          { opacity: 1, transform: "scale(1.015)", offset: 0.62 },
          { opacity: 1, transform: "scale(1)", offset: 1 },
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

export function achExitKeyframes(style: string, direction: 1 | -1 = 1): AchCardAnimation {
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
          { opacity: 0, transform: "scale(0.96)" },
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
export function playAchCardEntry(card: HTMLElement, style = "minimal", direction: 1 | -1 = 1): void {
  if (typeof card.animate !== "function") return;
  card.getAnimations().forEach((animation) => animation.cancel());
  const motion = normalizeAchMotion(style);
  if (reducedMotion()) {
    card.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 150,
      fill: "both",
    });
    return;
  }

  const entry = achEntryKeyframes(motion, direction);
  card.animate(entry.frames, {
    duration: entry.duration,
    easing: entry.easing,
    fill: "both",
  });

  // "Soft" is the quiet option: the card fades as one piece, no inner motion.
  if (motion === "soft") return;

  const ease = "cubic-bezier(0.16, 1, 0.3, 1)";
  const cancel = (element: HTMLElement) =>
    element.getAnimations().forEach((animation) => animation.cancel());

  if (motion !== "slide") {
    // The art tile lands just after the card so the eye starts on the picture.
    const medallion = card.querySelector<HTMLElement>(".ach-hud-medallion");
    if (medallion && typeof medallion.animate === "function") {
      cancel(medallion);
      medallion.animate(
        [
          { opacity: 0, transform: `scale(${motion === "pop" ? 0.7 : 0.82})`, offset: 0 },
          { opacity: 1, transform: `scale(${motion === "pop" ? 1.08 : 1.05})`, offset: 0.6 },
          { opacity: 1, transform: "scale(1)", offset: 1 },
        ],
        {
          duration: motion === "pop" ? 480 : 520,
          delay: 60,
          easing: "cubic-bezier(0.18, 1.2, 0.32, 1)",
          fill: "both",
        },
      );
    }
  }

  const textCol = card.querySelector<HTMLElement>(".ach-hud-text-col");
  if (textCol && typeof textCol.animate === "function") {
    cancel(textCol);
    textCol.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 300, delay: 60, easing: ease, fill: "both" },
    );
  }

  const tag = card.querySelector<HTMLElement>(".ach-hud-tag");
  if (tag && typeof tag.animate === "function") {
    cancel(tag);
    tag.animate(
      [
        { opacity: 0, clipPath: "inset(0 100% 0 0)" },
        { opacity: 1, clipPath: "inset(0 0% 0 0)" },
      ],
      { duration: 320, delay: 110, easing: ease, fill: "both" },
    );
  }

  const title = card.querySelector<HTMLElement>(".ach-hud-title");
  if (title && typeof title.animate === "function") {
    cancel(title);
    title.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "translateY(0px)" },
      ],
      { duration: 320, delay: 140, easing: ease, fill: "both" },
    );
  }

  const desc = card.querySelector<HTMLElement>(".ach-hud-desc");
  if (desc && typeof desc.animate === "function") {
    cancel(desc);
    desc.animate(
      [
        { opacity: 0, transform: "translateY(4px)" },
        { opacity: 1, transform: "translateY(0px)" },
      ],
      { duration: 320, delay: 170, easing: ease, fill: "both" },
    );
  }

  // The progress rule draws itself from the left once the text has landed.
  const fill = card.querySelector<HTMLElement>(".ach-hud-progress-fill");
  if (fill && typeof fill.animate === "function") {
    cancel(fill);
    fill.animate(
      [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
      { duration: 460, delay: 180, easing: ease, fill: "both" },
    );
  }
}

/** Plays the closing; `onDone` runs when the card is fully gone. */
export function playAchCardExit(
  card: HTMLElement,
  style = "minimal",
  direction: 1 | -1 = 1,
  onDone?: () => void,
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
  const exit = achExitKeyframes(style, direction);
  const animation = card.animate(exit.frames, {
    duration: exit.duration,
    easing: exit.easing,
    fill: "both",
  });
  animation.onfinish = () => onDone?.();
  return animation;
}
