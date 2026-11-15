/** Pure readiness check for the disc burn buttons. */

export interface DiscMediaState {
  mediaLoaded: boolean;
  mediaBlank: boolean;
  freeBytes: number;
  capacityBytes: number;
}

/** Free space for a blank disc, falling back to its capacity on drives that report 0. */
export function discFreeBytes(recorder: DiscMediaState): number {
  if (!recorder.mediaBlank) return 0;
  return recorder.freeBytes > 0 ? recorder.freeBytes : recorder.capacityBytes;
}

export function burnReady(
  recorder: DiscMediaState | undefined,
  bytes: number,
): boolean {
  return Boolean(
    recorder &&
      recorder.mediaLoaded &&
      recorder.mediaBlank &&
      discFreeBytes(recorder) >= bytes,
  );
}
