/**
 * The one notification choreography, shared by the Settings stage and the
 * in-game toast so the preview shows exactly what the game shows.
 *
 * It is a quiet rise and fade in, the same move reversed on the way out. No
 * bounce, flash, clip-path or camera move: a notification should arrive and
 * leave without the player having to follow it.
 */

export interface AchCardAnimation {
  frames: Keyframe[];
  duration: number;
  easing: string;
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

export function achEntryKeyframes(): AchCardAnimation {
  return {
    duration: 260,
    easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
    frames: [
      { opacity: 0, transform: "translateY(6px)" },
      { opacity: 1, transform: "translateY(0px)" },
    ],
  };
}

export function achExitKeyframes(): AchCardAnimation {
  return {
    duration: 200,
    easing: "cubic-bezier(0.4, 0, 1, 1)",
    frames: [
      { opacity: 1, transform: "translateY(0px)" },
      { opacity: 0, transform: "translateY(-5px)" },
    ],
  };
}

/** Plays the opening: the card fades and rises, the art tile settles just after. */
export function playAchCardEntry(card: HTMLElement): void {
  if (typeof card.animate !== "function") return;
  card.getAnimations().forEach((animation) => animation.cancel());
  if (reducedMotion()) {
    card.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 150,
      fill: "both",
    });
    return;
  }

  const entry = achEntryKeyframes();
  card.animate(entry.frames, {
    duration: entry.duration,
    easing: entry.easing,
    fill: "both",
  });

  const medallion = card.querySelector<HTMLElement>(".ach-hud-medallion");
  if (medallion && typeof medallion.animate === "function") {
    medallion.getAnimations().forEach((animation) => animation.cancel());
    medallion.animate(
      [
        { opacity: 0, transform: "scale(0.92)" },
        { opacity: 1, transform: "scale(1)" },
      ],
      { duration: 220, delay: 40, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)", fill: "both" },
    );
  }
}

/** Plays the closing; `onDone` runs when the card is fully gone. */
export function playAchCardExit(card: HTMLElement, onDone?: () => void): Animation | null {
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
  const exit = achExitKeyframes();
  const animation = card.animate(exit.frames, {
    duration: exit.duration,
    easing: exit.easing,
    fill: "both",
  });
  animation.onfinish = () => onDone?.();
  return animation;
}
