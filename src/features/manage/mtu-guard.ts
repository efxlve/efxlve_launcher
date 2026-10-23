/**
 * Cloud-sync MTU guard.
 *
 * When a sync fails, the launcher probes the network path once per session: a
 * path that carries smaller packets than the interface MTU black-holes large
 * uploads while everything else works. The probe result surfaces as a warning
 * with a one-click fix instead of a vague network error.
 */

import { isTauri } from "../../core/constants";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { t } from "../../i18n";
import { netMtuProbe } from "../../net-diag";
import { pushNotification } from "../notifications/notifications";

let checked = false;

/** Probes the path after a failed sync; a warning is raised only when broken. */
export async function checkMtuAfterSyncFailure(): Promise<void> {
  if (checked || !isTauri) return;
  checked = true;
  try {
    const probe = await netMtuProbe();
    if (!probe.broken) return;
    S.mtuIssue = probe;
    scheduleRender();
    pushNotification({
      kind: "error",
      title: t("manage.mtuTitle"),
      body: t("manage.mtuBody", { path: probe.pathMtu, iface: probe.interfaceMtu }),
    });
  } catch {
    // Diagnostics must never break the sync flow.
  }
}
