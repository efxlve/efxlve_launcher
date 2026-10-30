/**
 * Pasted note images: one compression path for the overlay and the launcher.
 *
 * The note body keeps a short `![alt](note-image:N)` marker; the compressed
 * data URL is written to the app data `note-images` folder by Rust, and the
 * note stores that absolute path. `noteImageSrc` turns a stored path back into
 * an asset URL for the markdown preview.
 */

import { convertFileSrc } from "@tauri-apps/api/core";

export const MAX_NOTE_IMAGES = 3;

/** A stored path becomes an asset URL; a pre-migration data URL passes through. */
export function noteImageSrc(value: string): string {
  if (!value || value.startsWith("data:")) return value;
  try {
    return convertFileSrc(value);
  } catch {
    return value;
  }
}

function readImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image"));
    };
    image.src = url;
  });
}

export async function compressPastedImage(file: File): Promise<string | null> {
  try {
    const image = await readImage(file);
    for (const maxSide of [960, 720, 512]) {
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      for (const quality of [0.82, 0.7, 0.55]) {
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        if (dataUrl.length <= 150_000) return dataUrl;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** The first image item on a clipboard event, or null. */
export function clipboardImage(event: ClipboardEvent): File | null {
  const items = event.clipboardData?.items;
  if (!items) return null;
  const item = Array.from(items).find((entry) => entry.type.startsWith("image/"));
  return item?.getAsFile() ?? null;
}
