/**
 * Network path diagnostics for cloud saves.
 *
 * A path that carries smaller packets than the interface MTU black-holes large
 * uploads (Epic's CS-UL-0) while handshakes and downloads still work. The
 * backend measures the path with `ping -f` and can apply the standard fix with
 * one elevated command.
 */

import { invoke } from "@tauri-apps/api/core";

export interface MtuProbe {
  /** Interface the default route uses. */
  interface: string;
  /** MTU the interface advertises. */
  interfaceMtu: number;
  /** Largest IP packet the path carries; 0 when the probe found nothing. */
  pathMtu: number;
  /** True when the interface sends bigger packets than the path carries. */
  broken: boolean;
  /** Interface MTU that fixes it. */
  suggestedMtu: number;
}

/** Measures the real path MTU and whether the interface overshoots it. */
export const netMtuProbe = () => invoke<MtuProbe>("net_mtu_probe");

/** Applies the interface MTU with one elevated `netsh` run (UAC prompt). */
export const netMtuFix = (iface: string, mtu: number) =>
  invoke<void>("net_mtu_fix", { interface: iface, mtu });
