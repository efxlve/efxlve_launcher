import { describe, expect, it } from "vitest";

import { isInstallParent, parentFolder } from "./archive-paths";

describe("archive folder helpers", () => {
  it("finds the parent of a Windows or Unix path", () => {
    expect(parentFolder("C:\\Games\\Epic\\Game")).toBe("c:\\games\\epic");
    expect(parentFolder("/home/efe/Games/Game")).toBe("/home/efe/games");
  });

  it("recognizes the folder that holds the installed game", () => {
    expect(isInstallParent("C:\\Games\\Epic", "C:\\Games\\Epic\\Game")).toBe(true);
    expect(isInstallParent("C:\\Games\\Epic\\", "C:\\Games\\Epic\\Game")).toBe(true);
    expect(isInstallParent("D:\\Backups", "C:\\Games\\Epic\\Game")).toBe(false);
    expect(isInstallParent("", "C:\\Games\\Epic\\Game")).toBe(false);
    expect(isInstallParent("C:\\Games\\Epic", "")).toBe(false);
  });
});
