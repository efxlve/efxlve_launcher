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
const MAX_ACHIEVEMENT: usize = 200;
const MAX_GUIDE_URL: usize = 2048;

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
    /// Stable achievement key when this note belongs to one achievement.
    #[serde(default)]
    pub achievement: String,
    /// Optional guide link attached to the achievement note.
    #[serde(default)]
    pub guide_url: String,
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
    #[serde(default)]
    pub achievement: String,
    #[serde(default)]
    pub guide_url: String,
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
    let achievement: String = input
        .achievement
        .trim()
        .chars()
        .take(MAX_ACHIEVEMENT)
        .collect();
    let guide_url: String = input.guide_url.trim().chars().take(MAX_GUIDE_URL).collect();
    if let Some(id) = input.id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        if let Some(existing) = file.notes.iter_mut().find(|note| note.id == id) {
            existing.scope = scope;
            existing.title = title;
            existing.body = body;
            existing.pinned = input.pinned;
            existing.color = normalize_color(&input.color);
            existing.achievement = achievement;
            existing.guide_url = guide_url;
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
        achievement,
        guide_url,
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
    achievement: Option<String>,
    guide_url: Option<String>,
) -> Result<Note, String> {
    let mut file = read_notes(&app);
    let input = NoteInput {
        id,
        scope,
        title,
        body,
        pinned,
        color,
        achievement: achievement.unwrap_or_default(),
        guide_url: guide_url.unwrap_or_default(),
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

/// Merges an exported file back in. Same id → the incoming note wins; the
/// timestamps of the export are kept, so a restore does not look brand new.
fn merge_import(file: &mut NotesFile, incoming: Vec<Note>, now: u64, seq: &mut u64) -> Result<u32, String> {
    let mut count = 0;
    for mut note in incoming {
        if note.id.trim().is_empty() {
            note.id = format!("{now:x}-{seq:x}");
            *seq += 1;
        }
        note.scope = normalize_scope(&note.scope);
        note.title = note.title.trim().chars().take(MAX_TITLE).collect();
        note.body = note.body.chars().take(MAX_BODY).collect();
        note.color = normalize_color(&note.color);
        note.achievement = note
            .achievement
            .trim()
            .chars()
            .take(MAX_ACHIEVEMENT)
            .collect();
        note.guide_url = note.guide_url.trim().chars().take(MAX_GUIDE_URL).collect();
        if note.created == 0 {
            note.created = now;
        }
        if note.updated == 0 {
            note.updated = note.created;
        }
        match file.notes.iter_mut().find(|existing| existing.id == note.id) {
            Some(existing) => {
                *existing = note;
                count += 1;
            }
            None => {
                if file.notes.len() >= MAX_NOTES {
                    return Err("@t:notes.full".to_string());
                }
                file.notes.push(note);
                count += 1;
            }
        }
    }
    Ok(count)
}

/// Imports an exported JSON payload (pasted into the settings field).
#[tauri::command]
pub fn notes_import_text(app: AppHandle, json: String) -> Result<u32, String> {
    let parsed: NotesFile = serde_json::from_str(&json).map_err(|_| "@t:notes.badJson".to_string())?;
    let mut file = read_notes(&app);
    let mut seq = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let count = merge_import(&mut file, parsed.notes, now_ms(), &mut seq)?;
    write_notes(&app, &file)?;
    Ok(count)
}

/// The export as markdown: one section per scope, newest first inside it.
fn notes_to_markdown(file: &NotesFile) -> String {
    let mut scopes: Vec<String> = Vec::new();
    for note in &file.notes {
        if !scopes.contains(&note.scope) {
            scopes.push(note.scope.clone());
        }
    }
    // The launcher's own notes lead, the games follow alphabetically.
    scopes.sort_by(|a, b| {
        let launcher = |scope: &String| scope == "launcher";
        launcher(b).cmp(&launcher(a)).then_with(|| a.cmp(b))
    });

    let mut out = String::from("# Efxlve notes\n");
    for scope in scopes {
        out.push_str(&format!("\n## {scope}\n"));
        let mut notes: Vec<&Note> = file.notes.iter().filter(|note| note.scope == scope).collect();
        notes.sort_by(|a, b| b.updated.cmp(&a.updated));
        for note in notes {
            let title = if note.title.trim().is_empty() { "Untitled" } else { note.title.trim() };
            out.push_str(&format!("\n### {title}\n\n"));
            out.push_str(note.body.trim_end());
            out.push_str("\n");
            if !note.guide_url.is_empty() {
                out.push_str(&format!("\nGuide: {}\n", note.guide_url.trim()));
            }
        }
    }
    out
}

/// Writes an export next to the user's downloads (or the app data) and returns
/// the path, so the settings page can offer to open the folder.
#[tauri::command]
pub fn notes_export(app: AppHandle, format: String) -> Result<String, String> {
    let file = read_notes(&app);
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (name, data) = if format == "markdown" {
        ("efxlve-notes.md".to_string(), notes_to_markdown(&file))
    } else {
        (
            "efxlve-notes.json".to_string(),
            serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?,
        )
    };
    let path = dir.join(name);
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
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
    fn achievement_metadata_survives_an_update() {
        let mut file = NotesFile::default();
        let note = upsert(
            &mut file,
            NoteInput {
                achievement: "ACH_BOSS".to_string(),
                guide_url: "https://example.com/guide".to_string(),
                ..input("steam::1", "Boss", "first")
            },
            1,
            1,
        )
        .unwrap();
        assert_eq!(note.achievement, "ACH_BOSS");
        assert_eq!(note.guide_url, "https://example.com/guide");

        let updated = upsert(
            &mut file,
            NoteInput {
                id: Some(note.id.clone()),
                achievement: "ACH_BOSS".to_string(),
                guide_url: "https://example.com/guide-2".to_string(),
                ..input("steam::1", "Boss", "second")
            },
            2,
            2,
        )
        .unwrap();
        assert_eq!(file.notes.len(), 1);
        assert_eq!(updated.body, "second");
        assert_eq!(updated.achievement, "ACH_BOSS");
        assert_eq!(updated.guide_url, "https://example.com/guide-2");
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

    #[test]
    fn importing_an_export_replaces_matching_ids() {
        let mut file = NotesFile::default();
        let first = upsert(&mut file, input("launcher", "a", "one"), 1000, 1).unwrap();
        let mut seq = 5;
        let incoming = vec![
            Note {
                id: first.id.clone(),
                scope: "launcher".to_string(),
                title: "a2".to_string(),
                body: "two".to_string(),
                pinned: true,
                color: "red".to_string(),
                achievement: String::new(),
                guide_url: String::new(),
                created: 500,
                updated: 900,
            },
            Note {
                id: "external-1".to_string(),
                scope: "steam::1".to_string(),
                title: "b".to_string(),
                body: String::new(),
                pinned: false,
                color: String::new(),
                achievement: String::new(),
                guide_url: String::new(),
                created: 0,
                updated: 0,
            },
        ];
        let count = merge_import(&mut file, incoming, 2000, &mut seq).unwrap();
        assert_eq!(count, 2);
        assert_eq!(file.notes.len(), 2);
        let replaced = file.notes.iter().find(|note| note.id == first.id).unwrap();
        assert_eq!(replaced.title, "a2");
        assert_eq!(replaced.created, 500);
        assert_eq!(replaced.updated, 900);
        let added = file.notes.iter().find(|note| note.id == "external-1").unwrap();
        assert_eq!(added.created, 2000);
        assert_eq!(added.scope, "steam::1");
    }

    #[test]
    fn markdown_export_puts_the_launcher_first() {
        let mut file = NotesFile::default();
        upsert(&mut file, input("steam::1", "Game note", "body"), 1, 1).unwrap();
        upsert(&mut file, input("launcher", "Home", "body"), 2, 2).unwrap();
        let markdown = notes_to_markdown(&file);
        let launcher_at = markdown.find("## launcher").unwrap();
        let game_at = markdown.find("## steam::1").unwrap();
        assert!(launcher_at < game_at);
        assert!(markdown.contains("### Game note"));
    }

    #[test]
    fn markdown_export_keeps_an_achievement_guide_link() {
        let mut file = NotesFile::default();
        upsert(
            &mut file,
            NoteInput {
                achievement: "ACH_1".to_string(),
                guide_url: "https://example.com/guide".to_string(),
                ..input("steam::1", "Boss", "note")
            },
            1,
            1,
        )
        .unwrap();
        let markdown = notes_to_markdown(&file);
        assert!(markdown.contains("Guide: https://example.com/guide"));
    }
}
