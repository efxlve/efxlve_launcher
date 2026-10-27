/**
 * One choreography for both surfaces: the Settings stage and the in-game
 * toast run these keyframes, so the preview shows exactly what the game shows.
 */

export interface AchCardAnimation {
  frames: Keyframe[];
  duration: number;
  easing: string;
}

/** Default closing move for an opening style (the UI no longer exposes it). */
export function resolveEffectiveExitStyle(animStyle: string, exitStyle?: string): string {
  if (exitStyle && exitStyle !== "auto") return exitStyle;
  switch (animStyle) {
    case "xbox":
    case "prism":
      return "collapse";
    case "playstation":
      return "glide";
    case "epic":
      return "fold";
    case "cyber":
      return "laser";
    case "shatter":
      return "implode";
    case "jackpot":
      return "zoom";
    default:
      return "collapse";
  }
}

export function achEntryKeyframes(animStyle: string): AchCardAnimation {
  switch (animStyle) {
    case "xbox":
      return {
        duration: 920,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        frames: [
          {
            opacity: 0,
            transform: "scale(0.35)",
            clipPath: "inset(0 calc(100% - 88px) 0 0 round 999px)",
            offset: 0,
          },
          {
            opacity: 1,
            transform: "scale(1.08)",
            clipPath: "inset(0 calc(100% - 88px) 0 0 round 999px)",
            offset: 0.26,
          },
          {
            opacity: 1,
            transform: "scale(1)",
            clipPath: "inset(0 calc(100% - 88px) 0 0 round 999px)",
            offset: 0.38,
          },
          {
            opacity: 1,
            transform: "scale(1)",
            clipPath: "inset(0 0% 0 0 round 999px)",
            offset: 0.98,
          },
          { opacity: 1, transform: "scale(1)", clipPath: "none", offset: 1 },
        ],
      };
    case "playstation":
      return {
        duration: 820,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        frames: [
          {
            opacity: 0,
            transform: "translateX(145px) scale(0.92)",
            filter: "brightness(1.85) blur(8px)",
            offset: 0,
          },
          {
            opacity: 1,
            transform: "translateX(-8px) scale(1.015)",
            filter: "brightness(1.22) blur(0px)",
            offset: 0.62,
          },
          {
            opacity: 1,
            transform: "translateX(0px) scale(1)",
            filter: "brightness(1) blur(0px)",
            offset: 1,
          },
        ],
      };
    case "epic":
      return {
        duration: 840,
        easing: "cubic-bezier(0.18, 1.15, 0.32, 1)",
        frames: [
          {
            opacity: 0,
            transform: "perspective(700px) rotateX(-78deg) translateY(-38px) scaleY(0.28)",
            filter: "brightness(2.0)",
            offset: 0,
          },
          {
            opacity: 1,
            transform: "perspective(700px) rotateX(12deg) translateY(6px) scaleY(1.04)",
            filter: "brightness(1.2)",
            offset: 0.55,
          },
          {
            opacity: 1,
            transform: "perspective(700px) rotateX(0deg) translateY(0px) scaleY(1)",
            filter: "brightness(1)",
            offset: 1,
          },
        ],
      };
    case "cyber":
      return {
        duration: 480,
        easing: "cubic-bezier(0.2, 1, 0.3, 1)",
        frames: [
          { opacity: 0, transform: "scaleY(0.04)", filter: "brightness(2.8)", offset: 0 },
          { opacity: 1, transform: "scaleY(0.04)", filter: "brightness(2.4)", offset: 0.25 },
          { opacity: 1, transform: "scaleY(1.03)", filter: "brightness(1.15)", offset: 0.65 },
          { opacity: 1, transform: "scaleY(1)", filter: "brightness(1)", offset: 1 },
        ],
      };
    case "shatter":
      return {
        duration: 820,
        easing: "cubic-bezier(0.18, 1.15, 0.32, 1)",
        frames: [
          {
            opacity: 0,
            transform: "translateY(-60px) scale(1.48)",
            filter: "brightness(2.4) blur(10px)",
            offset: 0,
          },
          {
            opacity: 1,
            transform: "translateY(10px) scale(0.89)",
            filter: "brightness(1.4) blur(0px)",
            offset: 0.34,
          },
          {
            opacity: 1,
            transform: "translateY(-5px) scale(1.05)",
            offset: 0.64,
          },
          {
            opacity: 1,
            transform: "translateY(2px) scale(0.99)",
            offset: 0.84,
          },
          {
            opacity: 1,
            transform: "translateY(0px) scale(1)",
            filter: "brightness(1) blur(0px)",
            offset: 1,
          },
        ],
      };
    case "jackpot":
      return {
        duration: 880,
        easing: "cubic-bezier(0.2, 1.18, 0.3, 1)",
        frames: [
          {
            opacity: 0,
            transform: "translateY(72px) scale(0.42)",
            filter: "brightness(2.2)",
            offset: 0,
          },
          { opacity: 1, transform: "translateY(-16px) scale(1.1)", offset: 0.24 },
          {
            opacity: 1,
            transform: "translate(-12px, 7px) rotate(-2.5deg) scale(0.96)",
            offset: 0.4,
          },
          {
            opacity: 1,
            transform: "translate(11px, -6px) rotate(2.5deg) scale(1.04)",
            offset: 0.56,
          },
          {
            opacity: 1,
            transform: "translate(-7px, 4px) rotate(-1.2deg) scale(0.99)",
            offset: 0.72,
          },
          {
            opacity: 1,
            transform: "translate(4px, -2px) rotate(0.6deg) scale(1.01)",
            offset: 0.86,
          },
          {
            opacity: 1,
            transform: "translate(0px, 0px) rotate(0deg) scale(1)",
            filter: "brightness(1)",
            offset: 1,
          },
        ],
      };
    default:
      return {
        duration: 840,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        frames: [
          {
            opacity: 0,
            transform: "translateY(-48px) scale(0.74)",
            clipPath: "inset(0 78% 0 0 round 16px)",
            filter: "brightness(1.9) blur(6px)",
            offset: 0,
          },
          {
            opacity: 1,
            transform: "translateY(6px) scale(1.035)",
            clipPath: "inset(0 0% 0 0 round 16px)",
            filter: "brightness(1.22) blur(0px)",
            offset: 0.48,
          },
          {
            opacity: 1,
            transform: "translateY(-2px) scale(0.995)",
            clipPath: "inset(0 0% 0 0 round 16px)",
            offset: 0.76,
          },
          {
            opacity: 1,
            transform: "translateY(0px) scale(1)",
            clipPath: "inset(0 0% 0 0 round 16px)",
            filter: "brightness(1) blur(0px)",
            offset: 1,
          },
        ],
      };
  }
}

export function achExitKeyframes(exitStyle: string, animStyle: string): AchCardAnimation {
  const effective = resolveEffectiveExitStyle(animStyle, exitStyle);
  const round = animStyle === "xbox" ? "999px" : "16px";
  switch (effective) {
    case "collapse":
      return {
        duration: 680,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
        frames: [
          {
            opacity: 1,
            transform: "scale(1)",
            clipPath: `inset(0 0% 0 0 round ${round})`,
            offset: 0,
          },
          {
            opacity: 1,
            transform: "scale(1.03)",
            clipPath: `inset(0 calc(100% - 88px) 0 0 round ${round})`,
            offset: 0.68,
          },
          {
            opacity: 0,
            transform: "scale(0.32) translateY(-14px)",
            clipPath: `inset(0 calc(100% - 88px) 0 0 round ${round})`,
            offset: 1,
          },
        ],
      };
    case "glide":
      return {
        duration: 620,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
        frames: [
          { opacity: 1, transform: "translateX(0px) scale(1)", filter: "blur(0px)", offset: 0 },
          { opacity: 1, transform: "translateX(-10px) scale(1.01)", filter: "blur(0px)", offset: 0.22 },
          { opacity: 0, transform: "translateX(140px) scale(0.92)", filter: "blur(6px)", offset: 1 },
        ],
      };
    case "fold":
      return {
        duration: 620,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
        frames: [
          {
            opacity: 1,
            transform: "perspective(700px) rotateX(0deg) scaleY(1)",
            filter: "brightness(1)",
            offset: 0,
          },
          {
            opacity: 1,
            transform: "perspective(700px) rotateX(-15deg) scaleY(1.04)",
            filter: "brightness(1.35)",
            offset: 0.25,
          },
          {
            opacity: 0,
            transform: "perspective(700px) rotateX(78deg) translateY(-28px) scaleY(0.15)",
            filter: "brightness(2.0)",
            offset: 1,
          },
        ],
      };
    case "laser":
      return {
        duration: 640,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
        frames: [
          {
            opacity: 1,
            transform: "scaleX(1) scaleY(1)",
            filter: "brightness(1) contrast(1)",
            offset: 0,
          },
          {
            opacity: 1,
            transform: "scaleX(1.04) scaleY(0.06)",
            filter: "brightness(2.4) contrast(2.0)",
            offset: 0.56,
          },
          {
            opacity: 0,
            transform: "scaleX(0.02) scaleY(0.02)",
            filter: "brightness(3.0)",
            offset: 1,
          },
        ],
      };
    case "implode":
      return {
        duration: 620,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
        frames: [
          { opacity: 1, transform: "scale(1)", filter: "brightness(1) blur(0px)", offset: 0 },
          { opacity: 1, transform: "scale(1.12)", filter: "brightness(1.5) blur(0px)", offset: 0.28 },
          {
            opacity: 0,
            transform: "scale(0.18) rotate(8deg)",
            filter: "brightness(2.4) blur(6px)",
            offset: 1,
          },
        ],
      };
    default:
      return {
        duration: 620,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
        frames: [
          { opacity: 1, transform: "translateY(0px) scale(1)", offset: 0 },
          { opacity: 1, transform: "translateY(12px) scale(0.95)", offset: 0.28 },
          { opacity: 0, transform: "translateY(-68px) scale(0.65)", offset: 1 },
        ],
      };
  }
}

/** Plays the opening: the card, the medallion pop and the text slide. */
export function playAchCardEntry(card: HTMLElement, animStyle: string, tier = 2): void {
  if (typeof card.animate !== "function") return;
  card.getAnimations().forEach((animation) => animation.cancel());

  // Distinct, buttery-smooth entrance for overlay system hints
  if (card.classList.contains("ach-hud-hint")) {
    card.animate(
      [
        { opacity: 0, transform: "translateY(-12px) scale(0.97)", filter: "brightness(1.25)" },
        { opacity: 1, transform: "translateY(0px) scale(1)", filter: "brightness(1)" },
      ],
      { duration: 380, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "both" },
    );
    const badge = card.querySelector<HTMLElement>(".ach-hint-badge");
    if (badge && typeof badge.animate === "function") {
      badge.getAnimations().forEach((a) => a.cancel());
      badge.animate(
        [
          { opacity: 0, transform: "scale(0.82) rotate(-6deg)" },
          { opacity: 1, transform: "scale(1) rotate(0deg)" },
        ],
        { duration: 400, delay: 50, easing: "cubic-bezier(0.18, 1.25, 0.32, 1)", fill: "both" },
      );
    }
    const textCol = card.querySelector<HTMLElement>(".ach-hint-text-col");
    if (textCol && typeof textCol.animate === "function") {
      textCol.getAnimations().forEach((a) => a.cancel());
      textCol.animate(
        [
          { opacity: 0, transform: "translateX(-10px)" },
          { opacity: 1, transform: "translateX(0px)" },
        ],
        { duration: 380, delay: 90, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "both" },
      );
    }
    return;
  }

  const entry = achEntryKeyframes(animStyle);
  card.animate(entry.frames, {
    duration: entry.duration,
    easing: entry.easing,
    fill: "both",
  });

  // Medallion punch: tier-graded overshoot + specular brightness spike
  const medallion = card.querySelector<HTMLElement>(".ach-hud-medallion");
  if (medallion && typeof medallion.animate === "function") {
    medallion.getAnimations().forEach((animation) => animation.cancel());
    // Bronze (0) soft 1.08x, Silver 1.13x, Gold 1.18x, Ultra 1.23x, Platinum 1.28x
    const peakScale = 1.08 + tier * 0.05;
    // Specular glint: low tier subtle brightness, high tier punchy flash
    const peakBright = 1.3 + tier * 0.25;
    medallion.animate(
      [
        { transform: "scale(0.35) rotate(-25deg)", opacity: 0, filter: "brightness(1)", offset: 0 },
        { transform: `scale(${peakScale}) rotate(5deg)`, opacity: 1, filter: `brightness(${peakBright})`, offset: 0.45 },
        { transform: "scale(1.02) rotate(1deg)", opacity: 1, filter: "brightness(1.1)", offset: 0.72 },
        { transform: "scale(1) rotate(0deg)", opacity: 1, filter: "brightness(1)", offset: 1 },
      ],
      { duration: 680, easing: "cubic-bezier(0.18, 1.25, 0.32, 1)", fill: "both" },
    );
  }

  // Text choreography: container slide + staggered children reveal
  const baseDelay = animStyle === "xbox" ? 280 : 120;
  const ease = "cubic-bezier(0.16, 1, 0.3, 1)";
  const cancelAnims = (el: HTMLElement) => el.getAnimations().forEach((a) => a.cancel());

  const textCol = card.querySelector<HTMLElement>(".ach-hud-text-col");
  if (textCol && typeof textCol.animate === "function") {
    cancelAnims(textCol);
    textCol.animate(
      [{ transform: "translateX(-14px)" }, { transform: "translateX(0px)" }],
      { duration: 420, delay: baseDelay, easing: ease, fill: "both" },
    );
  }

  const tag = card.querySelector<HTMLElement>(".ach-hud-tag");
  if (tag && typeof tag.animate === "function") {
    cancelAnims(tag);
    tag.animate(
      [
        { opacity: 0, clipPath: "inset(0 100% 0 0)" },
        { opacity: 1, clipPath: "inset(0 0% 0 0)" },
      ],
      { duration: 450, delay: baseDelay + 40, easing: ease, fill: "both" },
    );
  }

  const title = card.querySelector<HTMLElement>(".ach-hud-title");
  if (title && typeof title.animate === "function") {
    cancelAnims(title);
    title.animate(
      [
        { opacity: 0, transform: "translateY(10px)" },
        { opacity: 1, transform: "translateY(0px)" },
      ],
      { duration: 480, delay: baseDelay + 100, easing: ease, fill: "both" },
    );
  }

  const desc = card.querySelector<HTMLElement>(".ach-hud-desc");
  if (desc && typeof desc.animate === "function") {
    cancelAnims(desc);
    desc.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "translateY(0px)" },
      ],
      { duration: 420, delay: baseDelay + 200, easing: ease, fill: "both" },
    );
  }
}

/** Plays the closing; `onDone` runs when the card is fully gone. */
export function playAchCardExit(
  card: HTMLElement,
  animStyle: string,
  exitStyle: string | undefined,
  onDone?: () => void,
): Animation | null {
  if (typeof card.animate !== "function") {
    onDone?.();
    return null;
  }
  const exit = achExitKeyframes(exitStyle || "auto", animStyle);
  const animation = card.animate(exit.frames, {
    duration: exit.duration,
    easing: exit.easing,
    fill: "both",
  });
  animation.onfinish = () => onDone?.();
  return animation;
}
