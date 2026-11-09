/**
 * Local cover files: decode, downscale and re-encode before storage.
 *
 * Custom art is persisted as a data URL in localStorage. A picked photo can
 * be many megabytes, which grows further as base64; `setItem` then throws
 * QuotaExceededError and the save silently stops with the modal still open.
 * Scaling the picture to the size the target is painted at keeps every image
 * far below the origin quota. WebP keeps the alpha of a transparent logo.
 */

export type CoverFileTarget = "cover" | "hero" | "logo";

interface ArtBudget {
  /** Largest edge the image is stored at. */
  width: number;
  height: number;
  /** One stored data URL should stay below this many characters. */
  chars: number;
}

/** Painted size per target, plus the storage budget that goes with it. */
const BUDGET: Record<CoverFileTarget, ArtBudget> = {
  cover: { width: 480, height: 720, chars: 150_000 },
  hero: { width: 1280, height: 720, chars: 260_000 },
  logo: { width: 640, height: 640, chars: 150_000 },
};

/** The file pane advertises this limit; larger files are refused up front. */
const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** Quality ladder, tried until the data URL fits the target budget. */
const QUALITIES = [0.86, 0.74, 0.62];

function decodeFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image decode failed"));
    };
    image.src = url;
  });
}

function decodeDataUrl(value: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image decode failed"));
    image.src = value;
  });
}

function encode(
  image: HTMLImageElement,
  scale: number,
  format: "image/webp" | "image/jpeg",
  quality: number,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no canvas");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(format, quality);
}

/**
 * Shrinks one decoded image under `maxChars`; a logo never falls back to JPEG
 * because that would paint its transparent cut-out over black.
 */
function shrinkImage(image: HTMLImageElement, target: CoverFileTarget, maxChars: number): string {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) throw new Error("empty image");

  const box = BUDGET[target];
  let scale = Math.min(1, box.width / width, box.height / height);

  for (let attempt = 0; attempt < 4; attempt++) {
    for (const quality of QUALITIES) {
      const dataUrl = encode(image, scale, "image/webp", quality);
      if (dataUrl.length <= maxChars) return dataUrl;
    }
    scale *= 0.82;
  }

  if (target !== "logo") {
    const dataUrl = encode(image, scale, "image/jpeg", 0.8);
    if (dataUrl.length <= maxChars) return dataUrl;
  }
  throw new Error("image too large");
}

/** The number of characters a freshly picked image may take at this target. */
export function artDataBudget(target: CoverFileTarget): number {
  return BUDGET[target].chars;
}

/**
 * Reads a picked file into a data URL small enough to persist.
 *
 * Throws when the file is not an image or cannot fit the budget even at the
 * lowest quality; the caller shows the failure toast.
 */
export async function readCoverFile(file: File, target: CoverFileTarget): Promise<string> {
  if (!file.type.startsWith("image/") || file.size > MAX_FILE_BYTES) throw new Error("not an image");
  const image = await decodeFile(file);
  return shrinkImage(image, target, artDataBudget(target));
}

/**
 * Re-encodes an already stored data URL under a stricter budget. Non-data
 * values (web links and asset URLs) pass through untouched.
 */
export async function shrinkStoredArt(
  value: string,
  target: CoverFileTarget,
  maxChars = artDataBudget(target),
): Promise<string> {
  if (!value.startsWith("data:image/")) return value;
  const image = await decodeDataUrl(value);
  return shrinkImage(image, target, maxChars);
}
