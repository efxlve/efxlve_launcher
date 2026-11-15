// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  scan: vi.fn(async () => []),
  install: vi.fn(async () => ""),
}));

vi.mock("../../archive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../archive")>();
  return {
    ...actual,
    archiveScanFolder: ipc.scan,
    archiveXtoolInstall: ipc.install,
  };
});

// Keep the test off the app shell (the toast root and the event listeners).
vi.mock("../../core/toast", () => ({
  toast: vi.fn(),
  progressToast: vi.fn(() => ({ update: vi.fn(), close: vi.fn() })),
}));

import type { ArchiveSummary } from "../../archive";
import { S } from "../../core/state";
import { handleArchiveAction, openArchiveForGame } from "./archive-actions";

function summary(): ArchiveSummary {
  return {
    appName: "epic::Ginger",
    title: "Ginger",
  } as unknown as ArchiveSummary;
}

beforeEach(() => {
  S.archiveRunning = false;
  S.archiveBurning = null;
  S.archiveErasing = false;
  S.archiveEstimating = false;
  S.archiveXtoolInstalling = false;
  S.archiveResult = null;
  S.archiveSelectedApp = "";
  S.archiveSource = "";
  ipc.scan.mockClear();
  ipc.install.mockClear();
});

describe("archive busy guards", () => {
  it("keeps the archive panel while a disc is burning", () => {
    const result = summary();
    S.archiveBurning = 1;
    S.archiveSelectedApp = "epic::Ginger";
    S.archiveResult = result;

    openArchiveForGame("epic::Other");

    expect(S.archiveResult).toBe(result);
    expect(S.archiveSelectedApp).toBe("epic::Ginger");
  });

  it("does not start a scan while a backup is running", async () => {
    S.archiveRunning = true;
    S.archiveSource = "C:\\archives";

    expect(handleArchiveAction("archive-scan", undefined, document.body)).toBe(
      true,
    );
    await Promise.resolve();

    expect(ipc.scan).not.toHaveBeenCalled();
  });

  it("scans when no job is running", async () => {
    S.archiveSource = "C:\\archives";

    expect(handleArchiveAction("archive-scan", undefined, document.body)).toBe(
      true,
    );

    await vi.waitFor(() =>
      expect(ipc.scan).toHaveBeenCalledWith("C:\\archives"),
    );
  });

  it("does not install xtool while a restore is running", async () => {
    S.archiveRunning = true;

    expect(
      handleArchiveAction("archive-xtool-install", undefined, document.body),
    ).toBe(true);
    await Promise.resolve();

    expect(ipc.install).not.toHaveBeenCalled();
  });
});
