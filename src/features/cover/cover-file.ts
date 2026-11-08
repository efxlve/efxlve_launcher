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

/** Largest edge per target, matching the size the art is painted at. */
const MAX_EDGE: Record<CoverFileTarget, { width: number; height: number }> = {
  cover: { width: 660, height: 990 },
  hero: { width: 1600, height: 900 },
  logo: { width: 1024, height: 1024 },
};

/** One stored image past this many characters can fill the origin quota. */
const MAX_DATA_CHARS = 900_000;

/** The file pane advertises this limit; larger files are refused up front. */
const MAX_FILE_BYTES = 15 * 1024 * 1024;

function decode(file: File): Promise<HTMLImageElement> {
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

/**
 * Reads a picked file into a data URL small enough to persist.
 *
 * Throws when the file is not an image or cannot fit the quota even at the
 * lowest quality; the caller shows the failure toast.
 */
export async function readCoverFile(file: File, target: CoverFileTarget): Promise<string> {
  if (!file.type.startsWith("image/") || file.size > MAX_FILE_BYTES) throw new Error("not an image");
  const image = await decode(file);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) throw new Error("empty image");

  const box = MAX_EDGE[target];
  const scale = Math.min(1, box.width / width, box.height / height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no canvas");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  for (const quality of [0.9, 0.78, 0.66]) {
    const dataUrl = canvas.toDataURL("image/webp", quality);
    if (dataUrl.length <= MAX_DATA_CHARS) return dataUrl;
  }
  // A logo is usually a transparent PNG, so it never falls back to JPEG:
  // that would paint the cut-out over black.
  if (target !== "logo") {
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    if (dataUrl.length <= MAX_DATA_CHARS) return dataUrl;
  }
  throw new Error("image too large");
}
