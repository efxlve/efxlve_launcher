// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  scan: vi.fn(async () => []),
  install: vi.fn(async () => ""),
  recorders: vi.fn(async () => []),
  discs: vi.fn(async () => []),
  burn: vi.fn(async () => undefined),
  estimate: vi.fn(async () => ({}) as ArchiveEstimate),
  cancel: vi.fn(async () => true),
}));

vi.mock("../../archive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../archive")>();
  return {
    ...actual,
    archiveScanFolder: ipc.scan,
    archiveXtoolInstall: ipc.install,
    archiveDiscs: ipc.discs,
    discListRecorders: ipc.recorders,
    discBurnFolder: ipc.burn,
    archiveEstimate: ipc.estimate,
    archiveCancel: ipc.cancel,
  };
});

// Keep the test off the app shell (the toast root and the event listeners).
vi.mock("../../core/toast", () => ({
  toast: vi.fn(),
  progressToast: vi.fn(() => ({ update: vi.fn(), close: vi.fn() })),
}));

import type { ArchiveEstimate, ArchiveSummary } from "../../archive";
import { S } from "../../core/state";
import type { LibraryItem } from "../../core/types";
import {
  cancelEstimate,
  handleArchiveAction,
  loadArchiveDiscs,
  loadBurnRecorders,
  openArchiveForGame,
  requestEstimate,
} from "./archive-actions";

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
  S.archiveDiscsManifest = "";
  S.archiveBurnRecorder = "";
  S.archiveBurnDone = null;
  S.archiveEstimate = null;
  S.allGamesMap.clear();
  ipc.scan.mockClear();
  ipc.install.mockClear();
  ipc.recorders.mockClear();
  ipc.discs.mockClear();
  ipc.burn.mockClear();
  ipc.estimate.mockClear();
  ipc.cancel.mockClear();
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

  it("does not query recorders while a disc is burning", async () => {
    S.archiveBurning = 1;

    await loadBurnRecorders(true);

    expect(ipc.recorders).not.toHaveBeenCalled();
  });

  it("keeps the burn panel's manifest while a disc is burning", async () => {
    S.archiveBurning = 1;
    S.archiveDiscsManifest = "burning.json";

    await loadArchiveDiscs("other.json");

    expect(S.archiveDiscsManifest).toBe("burning.json");
    expect(ipc.discs).not.toHaveBeenCalled();
  });

  it("refreshes recorders after a burn finishes", async () => {
    S.archiveBurnRecorder = "drive";
    const target = document.createElement("button");
    target.dataset.folder = "C:\\disc-1";
    target.dataset.index = "1";

    expect(handleArchiveAction("archive-burn", undefined, target)).toBe(true);

    await vi.waitFor(() => expect(ipc.burn).toHaveBeenCalled());
    await vi.waitFor(() => expect(ipc.recorders).toHaveBeenCalled());
    expect(S.archiveBurning).toBeNull();
  });

  it("cancels the running estimate through the active job map", async () => {
    S.allGamesMap.set("steam::1", {
      key: "steam::1",
      title: "Game",
      installed: true,
      installPath: "C:\\Game",
    } as unknown as LibraryItem);
    S.archiveSelectedApp = "steam::1";
    let resolveEstimate!: (value: ArchiveEstimate) => void;
    ipc.estimate.mockImplementationOnce(
      () =>
        new Promise<ArchiveEstimate>((resolve) => {
          resolveEstimate = resolve;
        }),
    );

    const pending = requestEstimate();
    await vi.waitFor(() => expect(ipc.estimate).toHaveBeenCalled());

    await cancelEstimate();
    expect(ipc.cancel).toHaveBeenCalledWith("steam::1");

    resolveEstimate({} as ArchiveEstimate);
    await pending;
    expect(S.archiveEstimating).toBe(false);
  });
});
