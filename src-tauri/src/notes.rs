//! Notes: game notes and launcher notes, stored next to the settings.
//!
//! One JSON file (`<app_data>/notes.json`) holds every note, so the launcher,
//! the game drawer and the overlay all read and write the same list. The
//! overlay's old per-key `localStorage` notes are imported once through
//! `notes_import`; the file remembers that it happened, so two windows racing
//! the import cannot duplicate anything. Writes go to a temp file and replace,
//! so a crash in the middle cannot leave a truncated file.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager};

/// Notes are capped so a runaway import cannot grow the file without end.
const MAX_NOTES: usize = 5000;
const MAX_SCOPE: usize = 200;
const MAX_TITLE: usize = 300;
const MAX_BODY: usize = 200_000;

/// Suffix for ids created in this process, so two notes saved in the same
/// millisecond still differ.
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// One note. `scope` is the game key (`steam::123`, `gog::…`, `amazon::…`, an
/// Epic app name) or `"launcher"` for the notes that belong to no game.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub scope: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub pinned: bool,
    /// Accent name (`blue`, `green`, `yellow`, `red`, `purple`); anything else
    /// falls back to the neutral color in the UI.
    #[serde(default)]
    pub color: String,
    /// Unix milliseconds.
    #[serde(default)]
    pub created: u64,
    #[serde(default)]
    pub updated: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub notes: Vec<Note>,
    /// The overlay's localStorage notes were imported already.
    #[serde(default)]
    pub legacy_imported: bool,
}

fn default_version() -> u32 {
    1
}

impl Default for NotesFile {
    fn default() -> Self {
        Self {
            version: 1,
            notes: Vec::new(),
            legacy_imported: false,
        }
    }
}

/// What a save or an import hands in.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub color: String,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_scope(scope: &str) -> String {
    let trimmed = scope.trim();
    let value = if trimmed.is_empty() { "launcher" } else { trimmed };
    value.chars().take(MAX_SCOPE).collect()
}

fn normalize_color(color: &str) -> String {
    let value = color.trim().to_ascii_lowercase();
    match value.as_str() {
        "blue" | "green" | "yellow" | "red" | "purple" => value,
        _ => String::new(),
    }
}

/// Creates a note or updates the one the id names. The returned note is the
/// stored copy, timestamps and id included.
fn upsert(file: &mut NotesFile, input: NoteInput, now: u64, seq: u64) -> Result<Note, String> {
    let scope = normalize_scope(&input.scope);
    let title: String = input.title.trim().chars().take(MAX_TITLE).collect();
    let body: String = input.body.chars().take(MAX_BODY).collect();
    if let Some(id) = input.id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        if let Some(existing) = file.notes.iter_mut().find(|note| note.id == id) {
            existing.scope = scope;
            existing.title = title;
            existing.body = body;
            existing.pinned = input.pinned;
            existing.color = normalize_color(&input.color);
            existing.updated = now;
            return Ok(existing.clone());
        }
    }
    if file.notes.len() >= MAX_NOTES {
        return Err("@t:notes.full".to_string());
    }
    let note = Note {
        id: format!("{now:x}-{seq:x}"),
        scope,
        title,
        body,
        pinned: input.pinned,
        color: normalize_color(&input.color),
        created: now,
        updated: now,
    };
    file.notes.push(note.clone());
    Ok(note)
}

fn delete_note(file: &mut NotesFile, id: &str) -> bool {
    let before = file.notes.len();
    file.notes.retain(|note| note.id != id);
    file.notes.len() != before
}

/// The first line of a legacy note becomes its title: the old overlay notes
/// had no title field, and a wall of text is not a list row.
fn first_line(body: &str) -> String {
    body.lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim()
        .chars()
        .take(80)
        .collect()
}

/// Imports the legacy notes once. The file remembers the import, so a second
/// call is a no-op even from another window.
fn import_legacy(
    file: &mut NotesFile,
    items: Vec<NoteInput>,
    now: u64,
    seq: &mut u64,
) -> Result<u32, String> {
    if file.legacy_imported {
        return Ok(0);
    }
    let mut count = 0;
    for item in items {
        let mut input = item;
        if input.title.trim().is_empty() {
            input.title = first_line(&input.body);
        }
        upsert(file, input, now, *seq)?;
        *seq += 1;
        count += 1;
    }
    file.legacy_imported = true;
    Ok(count)
}

fn notes_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("notes.json")
}

fn read_notes(app: &AppHandle) -> NotesFile {
    std::fs::read_to_string(notes_path(app))
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

fn write_notes(app: &AppHandle, file: &NotesFile) -> Result<(), String> {
    let path = notes_path(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|e| e.to_string())?;
    // Every window keeps its own view of the list; the write tells them to
    // reload it (the overlay panel is a separate webview).
    let _ = app.emit("notes-changed", ());
    Ok(())
}

/// Every note, newest changes last. The lists are small; the surfaces filter
/// and sort their own view of this.
#[tauri::command]
pub fn notes_list(app: AppHandle) -> NotesFile {
    read_notes(&app)
}

/// Creates (`id` empty) or updates one note.
#[tauri::command]
pub fn notes_save(
    app: AppHandle,
    id: Option<String>,
    scope: String,
    title: String,
    body: String,
    pinned: bool,
    color: String,
) -> Result<Note, String> {
    let mut file = read_notes(&app);
    let input = NoteInput {
        id,
        scope,
        title,
        body,
        pinned,
        color,
    };
    let note = upsert(&mut file, input, now_ms(), NEXT_ID.fetch_add(1, Ordering::Relaxed))?;
    write_notes(&app, &file)?;
    Ok(note)
}

#[tauri::command]
pub fn notes_delete(app: AppHandle, id: String) -> Result<bool, String> {
    let mut file = read_notes(&app);
    let removed = delete_note(&mut file, &id);
    if removed {
        write_notes(&app, &file)?;
    }
    Ok(removed)
}

/// Imports the overlay's old localStorage notes. Runs once per file; later
/// calls report 0.
#[tauri::command]
pub fn notes_import(app: AppHandle, notes: Vec<NoteInput>) -> Result<u32, String> {
    let mut file = read_notes(&app);
    if file.legacy_imported {
        return Ok(0);
    }
    let mut seq = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let count = import_legacy(&mut file, notes, now_ms(), &mut seq)?;
    write_notes(&app, &file)?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(scope: &str, title: &str, body: &str) -> NoteInput {
        NoteInput {
            scope: scope.to_string(),
            title: title.to_string(),
            body: body.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn saving_creates_then_updates_one_note() {
        let mut file = NotesFile::default();
        let note = upsert(&mut file, input("steam::1", "Build", "- [ ] denemeler"), 1000, 1).unwrap();
        assert_eq!(note.scope, "steam::1");
        assert_eq!(note.created, 1000);
        assert_eq!(note.updated, 1000);

        let updated = upsert(
            &mut file,
            NoteInput {
                id: Some(note.id.clone()),
                pinned: true,
                color: "blue".to_string(),
                ..input("steam::1", "Build 2", "x")
            },
            2000,
            2,
        )
        .unwrap();
        assert_eq!(file.notes.len(), 1);
        assert_eq!(updated.created, 1000);
        assert_eq!(updated.updated, 2000);
        assert!(updated.pinned);
        assert_eq!(updated.color, "blue");
        assert_eq!(updated.title, "Build 2");
    }

    #[test]
    fn scope_defaults_to_launcher_and_unknown_colors_drop() {
        let mut file = NotesFile::default();
        let note = upsert(
            &mut file,
            NoteInput {
                scope: "  ".to_string(),
                color: "chartreuse".to_string(),
                ..Default::default()
            },
            1,
            1,
        )
        .unwrap();
        assert_eq!(note.scope, "launcher");
        assert_eq!(note.color, "");
    }

    #[test]
    fn legacy_import_happens_once_and_titles_itself() {
        let mut file = NotesFile::default();
        let mut seq = 1;
        let count = import_legacy(
            &mut file,
            vec![input("epic-app", "", "First line\nrest of the note")],
            10,
            &mut seq,
        )
        .unwrap();
        assert_eq!(count, 1);
        assert_eq!(file.notes[0].title, "First line");
        assert!(file.legacy_imported);

        let again = import_legacy(&mut file, vec![input("epic-app", "", "again")], 11, &mut seq).unwrap();
        assert_eq!(again, 0);
        assert_eq!(file.notes.len(), 1);
    }

    #[test]
    fn deleting_removes_only_the_match() {
        let mut file = NotesFile::default();
        let first = upsert(&mut file, input("launcher", "a", ""), 1, 1).unwrap();
        upsert(&mut file, input("launcher", "b", ""), 2, 2).unwrap();
        assert!(delete_note(&mut file, &first.id));
        assert_eq!(file.notes.len(), 1);
        assert!(!delete_note(&mut file, &first.id));
    }
}
