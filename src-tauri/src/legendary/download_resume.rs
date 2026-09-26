//! Decides whether a stopped download keeps its partial files and resume record.
//!
//! Legendary continues a partial install only when the next `legendary install`
//! uses the same base path and the game folder (including `.egstore`) is still
//! on disk. Deleting either one makes the next attempt start at byte 0.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One unfinished install. `install_dir` is the concrete `--base-path`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ResumeRecord {
    pub app_name: String,
    pub install_tags: Vec<String>,
    pub install_dir: Option<String>,
}

/// Why the legendary process is no longer the active download.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadStop {
    /// Explicit user cancel. Partial files may be removed only when this game
    /// was never installed; an update must keep the existing install folder.
    UserCancel { was_installed: bool },
    /// Unexpected exit, timeout, network drop, crash, or stall. Not a cancel.
    Failure,
    Pause,
    Success,
}

/// What the caller is allowed to do after `stop`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StopPlan {
    /// Delete the never-installed partial folder. False for every non-cancel stop.
    pub cleanup_partial: bool,
    /// Leave the on-disk resume record so the same folder can be continued.
    pub keep_resume_record: bool,
}

pub fn resumes_path() -> PathBuf {
    super::skip::default_config_dir().join("efxlve-download-resumes.json")
}

/// Pure rule shared by the monitor and the unit test.
pub fn plan_stop(stop: DownloadStop) -> StopPlan {
    match stop {
        DownloadStop::UserCancel { was_installed: false } => StopPlan {
            cleanup_partial: true,
            keep_resume_record: false,
        },
        DownloadStop::UserCancel { was_installed: true } => StopPlan {
            cleanup_partial: false,
            keep_resume_record: false,
        },
        DownloadStop::Failure | DownloadStop::Pause => StopPlan {
            cleanup_partial: false,
            keep_resume_record: true,
        },
        DownloadStop::Success => StopPlan {
            cleanup_partial: false,
            keep_resume_record: false,
        },
    }
}

/// Applies `plan_stop` to the resume file. Does not delete game folders;
/// the caller may do that only when `cleanup_partial` is set.
pub fn commit_stop(path: &Path, app_name: &str, stop: DownloadStop) -> StopPlan {
    let plan = plan_stop(stop);
    if !plan.keep_resume_record {
        remove_resume(path, app_name);
    }
    plan
}

/// Saved base path and tags win so a retry cannot land in an empty folder.
pub fn merge_resume(saved: Option<&ResumeRecord>, requested: ResumeRecord) -> ResumeRecord {
    let Some(saved) = saved else {
        return requested;
    };
    if saved.app_name != requested.app_name {
        return requested;
    }
    ResumeRecord {
        app_name: requested.app_name,
        install_tags: if saved.install_tags.is_empty() {
            requested.install_tags
        } else {
            saved.install_tags.clone()
        },
        install_dir: saved.install_dir.clone().or(requested.install_dir),
    }
}

pub fn load_one(path: &Path, app_name: &str) -> Option<ResumeRecord> {
    load_all(path).remove(app_name)
}

pub fn save_one(path: &Path, record: &ResumeRecord) {
    let mut all = load_all(path);
    all.insert(record.app_name.clone(), record.clone());
    write_all(path, &all);
}

pub fn remove_resume(path: &Path, app_name: &str) {
    let mut all = load_all(path);
    if all.remove(app_name).is_some() {
        write_all(path, &all);
    }
}

fn load_all(path: &Path) -> BTreeMap<String, ResumeRecord> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_all(path: &Path, all: &BTreeMap<String, ResumeRecord>) {
    if all.is_empty() {
        let _ = std::fs::remove_file(path);
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(all) {
        let _ = std::fs::write(path, text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(dir: &str) -> ResumeRecord {
        ResumeRecord {
            app_name: "fortnite".into(),
            install_tags: vec!["en".into()],
            install_dir: Some(dir.into()),
        }
    }

    fn temp_store(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("efxlve_resume_{name}"));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path.join("resumes.json")
    }

    #[test]
    fn failure_keeps_resume_record_and_does_not_schedule_partial_cleanup() {
        let path = temp_store("failure");
        save_one(&path, &sample(r"D:\Games"));

        let plan = commit_stop(&path, "fortnite", DownloadStop::Failure);
        assert!(!plan.cleanup_partial);
        assert!(plan.keep_resume_record);
        assert_eq!(
            load_one(&path, "fortnite").and_then(|r| r.install_dir),
            Some(r"D:\Games".to_string())
        );

        let paused = commit_stop(&path, "fortnite", DownloadStop::Pause);
        assert!(!paused.cleanup_partial);
        assert!(load_one(&path, "fortnite").is_some());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn user_cancel_of_unfinished_install_may_cleanup_and_drops_the_record() {
        let path = temp_store("cancel");
        save_one(&path, &sample(r"D:\Games"));
        // A second game's record must survive a cancel of the first.
        save_one(
            &path,
            &ResumeRecord {
                app_name: "rocketleague".into(),
                install_tags: Vec::new(),
                install_dir: Some(r"E:\Games".into()),
            },
        );

        let plan = commit_stop(
            &path,
            "fortnite",
            DownloadStop::UserCancel { was_installed: false },
        );
        assert!(plan.cleanup_partial);
        assert!(!plan.keep_resume_record);
        assert!(load_one(&path, "fortnite").is_none());
        assert!(load_one(&path, "rocketleague").is_some());

        // An update cancel must not schedule deletion of the installed game folder.
        save_one(&path, &sample(r"D:\Games"));
        let update = commit_stop(
            &path,
            "fortnite",
            DownloadStop::UserCancel { was_installed: true },
        );
        assert!(!update.cleanup_partial);
        assert!(load_one(&path, "fortnite").is_none());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn merge_resume_keeps_the_saved_base_path_and_tags() {
        let saved = sample(r"D:\Games");
        let requested = ResumeRecord {
            app_name: "fortnite".into(),
            install_tags: Vec::new(),
            install_dir: Some(r"C:\Users\Efe\Games".into()),
        };
        let merged = merge_resume(Some(&saved), requested);
        assert_eq!(merged.install_dir.as_deref(), Some(r"D:\Games"));
        assert_eq!(merged.install_tags, vec!["en".to_string()]);

        let fresh = merge_resume(
            None,
            ResumeRecord {
                app_name: "fortnite".into(),
                install_tags: vec!["fr".into()],
                install_dir: Some(r"C:\Games".into()),
            },
        );
        assert_eq!(fresh.install_dir.as_deref(), Some(r"C:\Games"));
        assert_eq!(fresh.install_tags, vec!["fr".to_string()]);
    }
}
