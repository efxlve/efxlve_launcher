/** Pure readiness check for the disc burn buttons. */

export interface DiscMediaState {
  mediaLoaded: boolean;
  mediaBlank: boolean;
  freeBytes: number;
}

export function burnReady(
  recorder: DiscMediaState | undefined,
  bytes: number,
): boolean {
  return Boolean(
    recorder &&
      recorder.mediaLoaded &&
      recorder.mediaBlank &&
      recorder.freeBytes >= bytes,
  );
}
