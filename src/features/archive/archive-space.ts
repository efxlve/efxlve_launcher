/**
 * Free-space check for the archive screen. The backend plan is deliberately
 * conservative and counts the whole uncompressed game; once the user asks for
 * an estimate we know the archive will be smaller, so the check must use that
 * number or a compressed backup that fits would still be blocked.
 */
export const ARCHIVE_SPACE_PAD = 64 * 1024 * 1024;

export function archiveRequiredBytes(
  planRequiredBytes: number,
  estimatedBytes: number | null,
): number {
  if (estimatedBytes != null) return estimatedBytes + ARCHIVE_SPACE_PAD;
  return planRequiredBytes;
}

export function archiveFits(
  freeBytes: number | null,
  planRequiredBytes: number,
  estimatedBytes: number | null,
): boolean {
  if (freeBytes == null) return true;
  return freeBytes >= archiveRequiredBytes(planRequiredBytes, estimatedBytes);
}
