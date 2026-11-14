/**
 * Connect/disconnect notices for controllers.
 *
 * Two sources report the same pad: the WebView's Gamepad API, which only lists
 * a pad after its first button press, and the OS HID list, which sees it at
 * once. One announced set keeps a single notice per transition and remembers
 * the name for the disconnect, when no pad object is left to read.
 */

import type { ControllerKind } from "../../core/types";
import type { ConnectedController } from "../../epic";

export interface PadNotice {
  connected: boolean;
  kind: ControllerKind;
  name: string;
}

export class PadNotices {
  private readonly announced = new Map<ControllerKind, string>();
  private nativeKinds: ControllerKind[] = [];
  private seeded = false;

  /**
   * Takes an OS pad list. The first call only seeds the watch: a pad that was
   * already here when the launcher opened is not "just connected".
   */
  updateNative(pads: ConnectedController[]): PadNotice[] {
    const kinds = pads.map((pad) => pad.kind);
    if (!this.seeded) {
      this.seeded = true;
      for (const pad of pads) this.announced.set(pad.kind, pad.name);
      this.nativeKinds = kinds;
      return [];
    }
    const notices: PadNotice[] = [];
    for (const pad of pads) {
      if (this.nativeKinds.includes(pad.kind)) continue;
      const notice = this.connect(pad.kind, pad.name);
      if (notice) notices.push(notice);
    }
    for (const kind of this.nativeKinds) {
      if (kinds.includes(kind)) continue;
      const notice = this.disconnect(kind);
      if (notice) notices.push(notice);
    }
    this.nativeKinds = kinds;
    return notices;
  }

  /** The Gamepad API saw a pad whose first button press unlocked it. */
  webConnected(kind: ControllerKind, name: string): PadNotice | null {
    return this.connect(kind, name);
  }

  webDisconnected(kind: ControllerKind): PadNotice | null {
    return this.disconnect(kind);
  }

  private connect(kind: ControllerKind, name: string): PadNotice | null {
    if (this.announced.has(kind)) return null;
    this.announced.set(kind, name);
    return { connected: true, kind, name };
  }

  private disconnect(kind: ControllerKind): PadNotice | null {
    const name = this.announced.get(kind);
    if (name === undefined) return null;
    this.announced.delete(kind);
    return { connected: false, kind, name };
  }
}
