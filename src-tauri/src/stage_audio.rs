//! User-supplied Stage background music.
//!
//! The launcher never bundles third-party music. A player can import their own
//! audio file; it is copied into the app data folder and served back through
//! Tauri's asset protocol. The frontend stores only the stable file name.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// A long console-style loop can be large; notification sounds have their own
/// smaller limit. This is still small enough to copy synchronously on a click.
const MAX_AUDIO_BYTES: u64 = 64 * 1024 * 1024;

const AUDIO_EXTENSIONS: &[&str] = &["mp3", "ogg", "wav", "m4a", "aac", "flac", "opus", "webm"];

#[derive(Clone, Debug, serde::Serialize)]
pub struct StageAudioFile {
    /// Stable name stored in the player's Stage settings.
    pub name: String,
    /// Human-readable name shown in Settings and on a game page.
    pub label: String,
    /// Absolute path used to build the asset URL.
    pub path: String,
    pub size: u64,
}

fn audio_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("stage-audio");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn is_audio_extension(value: &str) -> bool {
    AUDIO_EXTENSIONS
        .iter()
        .any(|extension| extension.eq_ignore_ascii_case(value))
}

/// A stored name must be one plain file name, not a path or a traversal.
fn safe_stored_name(value: &str) -> Option<&str> {
    let path = Path::new(value);
    if value.is_empty() || path.components().count() != 1 {
        return None;
    }
    let file_name = path.file_name()?.to_str()?;
    if file_name != value || file_name.starts_with('.') {
        return None;
    }
    let extension = path.extension()?.to_str()?;
    is_audio_extension(extension).then_some(value)
}

fn sanitize_label(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut last_dash = false;
    for ch in value.chars() {
        let keep = ch.is_alphanumeric() || ch == ' ' || ch == '_' || ch == '-';
        let next = if keep { ch } else { ' ' };
        if next == ' ' {
            if last_dash || out.is_empty() {
                continue;
            }
            last_dash = true;
            out.push(' ');
        } else {
            last_dash = false;
            out.push(next);
        }
        if out.chars().count() >= 64 {
            break;
        }
    }
    let trimmed = out.trim_matches(|ch: char| ch == ' ' || ch == '-' || ch == '_');
    if trimmed.is_empty() {
        "Stage audio".to_string()
    } else {
        trimmed.to_string()
    }
}

fn label_from_name(name: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(name);
    // Imported names end in `-<timestamp>`; keep the player's own title.
    let cleaned = stem
        .rsplit_once('-')
        .filter(|(_, stamp)| stamp.chars().all(|ch| ch.is_ascii_digit()))
        .map(|(label, _)| label)
        .unwrap_or(stem);
    sanitize_label(&cleaned.replace('_', " "))
}

fn file_entry(path: &Path) -> Option<StageAudioFile> {
    let name = path.file_name()?.to_str()?.to_string();
    safe_stored_name(&name)?;
    let metadata = std::fs::metadata(path).ok()?;
    Some(StageAudioFile {
        label: label_from_name(&name),
        name,
        path: path.to_string_lossy().to_string(),
        size: metadata.len(),
    })
}

fn import_into(dir: &Path, source_path: &Path) -> Result<StageAudioFile, String> {
    if !source_path.is_file() {
        return Err("The selected audio file does not exist".into());
    }
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !is_audio_extension(&extension) {
        return Err("Choose an MP3, OGG, WAV, M4A, AAC, FLAC, OPUS or WEBM audio file".into());
    }
    let metadata = std::fs::metadata(source_path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_AUDIO_BYTES {
        return Err("The audio file must be smaller than 64 MB".into());
    }
    let stem = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("stage-audio");
    let label = sanitize_label(stem);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let safe_stem: String = label
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch == '_' {
                ch
            } else if ch == ' ' {
                '_'
            } else {
                '-'
            }
        })
        .collect();
    let name = format!("{safe_stem}-{stamp}.{extension}");
    let target = dir.join(&name);
    std::fs::copy(source_path, &target).map_err(|error| error.to_string())?;
    file_entry(&target).ok_or_else(|| "The imported audio file could not be read".to_string())
}

/// Copies a user-selected audio file into the Stage audio folder.
#[tauri::command]
pub fn stage_audio_import(app: AppHandle, source: String) -> Result<StageAudioFile, String> {
    import_into(&audio_dir(&app)?, Path::new(&source))
}

#[tauri::command]
pub fn stage_audio_list(app: AppHandle) -> Result<Vec<StageAudioFile>, String> {
    let dir = audio_dir(&app)?;
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|error| error.to_string())? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Some(file) = file_entry(&path) {
            files.push(file);
        }
    }
    files.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    Ok(files)
}

#[tauri::command]
pub fn stage_audio_delete(app: AppHandle, name: String) -> Result<(), String> {
    let name = safe_stored_name(&name).ok_or_else(|| "Invalid audio file name".to_string())?;
    let path = audio_dir(&app)?.join(name);
    if path.is_file() {
        std::fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_names_stay_inside_the_audio_folder() {
        assert!(safe_stored_name("theme-123.mp3").is_some());
        assert!(safe_stored_name("theme 123.ogg").is_some());
        assert!(safe_stored_name("../theme.mp3").is_none());
        assert!(safe_stored_name("folder/theme.mp3").is_none());
        assert!(safe_stored_name(".hidden.mp3").is_none());
        assert!(safe_stored_name("theme.txt").is_none());
        assert!(safe_stored_name("").is_none());
    }

    #[test]
    fn labels_drop_import_timestamps_and_unsafe_characters() {
        assert_eq!(label_from_name("My Theme-1712345678901.mp3"), "My Theme");
        assert_eq!(
            label_from_name("PS4_Ambient-1712345678901.ogg"),
            "PS4 Ambient"
        );
        assert_eq!(sanitize_label("  a/b:c  "), "a b c");
        assert_eq!(sanitize_label(""), "Stage audio");
    }

    #[test]
    fn import_copies_the_file_and_keeps_the_player_title() {
        let root = std::env::temp_dir().join(format!(
            "efxlve-stage-audio-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("My Theme.mp3");
        std::fs::write(&source, b"audio").unwrap();
        let file = import_into(&root, &source).unwrap();
        assert_eq!(file.label, "My Theme");
        assert!(file.name.ends_with(".mp3"));
        assert!(Path::new(&file.path).is_file());
        let _ = std::fs::remove_dir_all(root);
    }
}
