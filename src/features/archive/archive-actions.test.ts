// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  scan: vi.fn(async () => []),
  install: vi.fn(async () => ""),
  recorders: vi.fn(async () => []),
  discs: vi.fn(async () => []),
  burn: vi.fn(async () => undefined),
  estimate: vi.fn(async () => ({}) as ArchiveEstimate),
  plan: vi.fn(async () => ({}) as ArchivePlan),
  cancel: vi.fn(async () => true),
  start: vi.fn(async () => ({
    appName: "steam::1",
    title: "Game",
    store: "steam",
    folder: "C:\\archives\\game",
    manifestPath: "C:\\archives\\game\\manifest.efxmeta.json",
    originalBytes: 10,
    storedBytes: 5,
    volumeCount: 1,
    volumes: [],
    compression: {},
    createdAt: 0,
    discLayout: false,
  })),
  verify: vi.fn(async () => ({
    appName: "steam::1",
    title: "Game",
    blocks: 1,
    volumeCount: 1,
  })),
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
    archivePlan: ipc.plan,
    archiveCancel: ipc.cancel,
    archiveStart: ipc.start,
    archiveVerify: ipc.verify,
  };
});

// Keep the test off the app shell (the toast root and the event listeners).
vi.mock("../../core/toast", () => ({
  toast: vi.fn(),
  progressToast: vi.fn(() => ({ update: vi.fn(), close: vi.fn() })),
}));

vi.mock("../../core/render", () => ({ scheduleRender: vi.fn() }));

import type { ArchiveEstimate, ArchivePlan, ArchiveSummary, FoundArchive } from "../../archive";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import type { LibraryItem } from "../../core/types";
import {
  cancelEstimate,
  handleArchiveAction,
  handleArchiveChange,
  loadArchiveDiscs,
  loadArchivePlan,
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
  S.archiveEraseArmed = false;
  S.archiveEraseFull = false;
  S.archiveResult = null;
  S.archivePlan = null;
  S.archiveSelectedApp = "";
  S.archiveSource = "";
  S.archiveDiscsManifest = "";
  S.archiveBurnRecorder = "";
  S.archiveBurnDone = null;
  S.archiveEstimate = null;
  S.archiveFound = null;
  S.archiveVerifyResult = null;
  S.archiveVerifyAfterBackup = false;
  S.archiveFullRecovery = false;
  S.runningGames.clear();
  S.allGamesMap.clear();
  ipc.scan.mockClear();
  ipc.install.mockClear();
  ipc.recorders.mockClear();
  ipc.discs.mockClear();
  ipc.burn.mockClear();
  ipc.estimate.mockClear();
  ipc.plan.mockClear();
  ipc.cancel.mockClear();
  ipc.start.mockClear();
  ipc.verify.mockClear();
  vi.mocked(scheduleRender).mockClear();
  vi.mocked(toast).mockClear();
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

  it("disarms the erase confirmation when full erase changes", () => {
    S.archiveEraseArmed = true;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;
    input.dataset.act = "archive-erase-full";

    expect(handleArchiveChange(input)).toBe(true);

    expect(S.archiveEraseFull).toBe(true);
    expect(S.archiveEraseArmed).toBe(false);
  });

  it("clears the stale plan as soon as the target folder changes", () => {
    S.archivePlan = {
      archivePath: "C:\\Program Files\\Epic Games\\old",
    } as ArchivePlan;
    const input = document.createElement("input");
    input.value = "D:\\Backups";
    input.dataset.act = "archive-target-input";

    expect(handleArchiveChange(input)).toBe(true);

    expect(S.archiveTarget).toBe("D:\\Backups");
    expect(S.archivePlan).toBeNull();
    expect(scheduleRender).toHaveBeenCalled();
  });

  it("reports a failed plan instead of leaving the old summary", async () => {
    S.allGamesMap.set("steam::1", {
      key: "steam::1",
      title: "Game",
      installed: true,
      installPath: "C:\\Game",
    } as unknown as LibraryItem);
    S.archiveSelectedApp = "steam::1";
    S.archiveTarget = "C:\\archives";
    ipc.plan.mockRejectedValueOnce("planner failed");

    await loadArchivePlan();

    expect(S.archivePlan).toBeNull();
    expect(toast).toHaveBeenCalled();
  });

  it("drops the estimate and reloads the plan when full recovery is toggled", async () => {
    S.allGamesMap.set("steam::1", {
      key: "steam::1",
      title: "Game",
      installed: true,
      installPath: "C:\\Game",
    } as unknown as LibraryItem);
    S.archiveSelectedApp = "steam::1";
    S.archiveTarget = "C:\\archives";
    S.archiveEstimate = { estimatedBytes: 10 } as ArchiveEstimate;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;
    input.dataset.act = "archive-full-recovery";

    expect(handleArchiveChange(input)).toBe(true);

    expect(S.archiveFullRecovery).toBe(true);
    expect(S.archiveEstimate).toBeNull();
    await vi.waitFor(() => expect(ipc.plan).toHaveBeenCalled());
    expect(ipc.plan).toHaveBeenCalledWith(
      expect.objectContaining({ fullVolumeRecovery: true }),
    );
  });

  it("verifies the selected archive without a restore target", async () => {
    const manifestPath = "C:\\archives\\manifest.efxmeta.json";
    S.archiveFound = [
      {
        manifestPath,
        manifest: {
          appName: "steam::1",
          title: "Game",
          volumes: [],
        },
        missingVolumes: [],
        storedBytes: 10,
      } as unknown as FoundArchive,
    ];
    const target = document.createElement("button");
    target.dataset.manifest = manifestPath;

    expect(handleArchiveAction("archive-verify", undefined, target)).toBe(true);

    await vi.waitFor(() =>
      expect(ipc.verify).toHaveBeenCalledWith(manifestPath, []),
    );
    await vi.waitFor(() => expect(S.archiveVerifyResult?.blocks).toBe(1));
    expect(S.archiveRunning).toBe(false);
  });

  it("verifies the new backup when the option is on", async () => {
    S.allGamesMap.set("steam::1", {
      key: "steam::1",
      title: "Game",
      installed: true,
      installPath: "C:\\Game",
    } as unknown as LibraryItem);
    S.archiveSelectedApp = "steam::1";
    S.archiveVerifyAfterBackup = true;

    expect(handleArchiveAction("archive-start", undefined, document.body)).toBe(
      true,
    );

    await vi.waitFor(() => expect(ipc.start).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(ipc.verify).toHaveBeenCalledWith(
        "C:\\archives\\game\\manifest.efxmeta.json",
        [],
      ),
    );
    await vi.waitFor(() => expect(S.archiveRunning).toBe(false));
    expect(S.archiveResult?.manifestPath).toBe(
      "C:\\archives\\game\\manifest.efxmeta.json",
    );
  });
});
