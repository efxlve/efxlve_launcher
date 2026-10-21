import { invoke } from "@tauri-apps/api/core";

export interface FeedbackReport {
  path: string;
  folder: string;
  files: string[];
  issueTitle: string;
  issueBody: string;
}

export const feedbackCreateReport = (note: string, includeLogs: boolean) =>
  invoke<FeedbackReport>("feedback_create_report", { note, includeLogs });

export const feedbackHasCrash = () => invoke<boolean>("feedback_has_crash");

export const feedbackRecoveryPending = () =>
  invoke<boolean>("feedback_recovery_pending");
