use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemDriveInfo {
    pub letter: String,
    pub label: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
    /// `Some(true)` for SSD, `Some(false)` for HDD, `None` when Windows cannot
    /// report the seek penalty.
    pub is_ssd: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoveGameProgress {
    pub id: String,
    pub stage: String, // "preparing" | "moving" | "verifying" | "cleaning" | "complete" | "failed"
    pub percent: f64,
    pub copied_bytes: u64,
    pub total_bytes: u64,
    pub speed: String,
    pub eta: String,
    pub current_file: String,
    pub files_copied: usize,
    pub total_files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoveGameResult {
    pub success: bool,
    pub new_path: String,
    pub message: String,
}

// Global cancel flags so in-progress moves can be cancelled
static ACTIVE_MOVES: std::sync::OnceLock<RwLock<HashMap<String, Arc<AtomicBool>>>> =
    std::sync::OnceLock::new();

fn get_active_moves() -> &'static RwLock<HashMap<String, Arc<AtomicBool>>> {
    ACTIVE_MOVES.get_or_init(|| RwLock::new(HashMap::new()))
}

#[cfg(windows)]
mod win_disk {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetLogicalDrives() -> u32;
        fn GetDriveTypeW(lpRootPathName: *const u16) -> u32;
        fn GetDiskFreeSpaceExW(
            lpDirectoryName: *const u16,
            lpFreeBytesAvailableToCaller: *mut u64,
            lpTotalNumberOfBytes: *mut u64,
            lpTotalNumberOfFreeBytes: *mut u64,
        ) -> i32;
    }

    /// Drive types that can hold a game folder. CD/DVD (5) and missing roots (1) are skipped.
    pub fn is_storage_drive(root: &Path) -> bool {
        let mut wide: Vec<u16> = root.as_os_str().encode_wide().collect();
        wide.push(0);
        let kind = unsafe { GetDriveTypeW(wide.as_ptr()) };
        matches!(kind, 2 | 3 | 4 | 6)
    }

    pub fn logical_drive_mask() -> u32 {
        unsafe { GetLogicalDrives() }
    }

    pub fn get_disk_space(path: &Path) -> Option<(u64, u64)> {
        let mut path_utf16: Vec<u16> = path.as_os_str().encode_wide().collect();
        path_utf16.push(0);

        let mut free_available: u64 = 0;
        let mut total_bytes: u64 = 0;
        let mut total_free: u64 = 0;

        let ret = unsafe {
            GetDiskFreeSpaceExW(
                path_utf16.as_ptr(),
                &mut free_available,
                &mut total_bytes,
                &mut total_free,
            )
        };

        if ret != 0 {
            // Caller quota can be 0 on a drive that still has free bytes. Use the larger figure.
            Some((free_available.max(total_free), total_bytes))
        } else {
            None
        }
    }
}

/// Lists all local drives (C:, D:, E:, ...) and their free space
pub fn get_system_drives() -> Vec<SystemDriveInfo> {
    let mut drives = Vec::new();

    #[cfg(windows)]
    {
        use sysinfo::{DiskKind, Disks};

        let disks = Disks::new_with_refreshed_list();
        let kind_for = |letter: char| -> Option<bool> {
            let bare = format!("{letter}:");
            let root = format!("{letter}:\\");
            disks
                .iter()
                .find(|disk| {
                    let mount = disk.mount_point().to_string_lossy();
                    mount.eq_ignore_ascii_case(&bare) || mount.eq_ignore_ascii_case(&root)
                })
                .and_then(|disk| match disk.kind() {
                    DiskKind::SSD => Some(true),
                    DiskKind::HDD => Some(false),
                    _ => None,
                })
        };

        let mask = win_disk::logical_drive_mask();
        for i in 0..26 {
            if mask & (1 << i) == 0 {
                continue;
            }
            let letter_char = b'A' + i;
            let drive_str = format!("{}:\\", letter_char as char);
            let drive_path = Path::new(&drive_str);
            if !win_disk::is_storage_drive(drive_path) {
                continue;
            }
            if let Some((free, total)) = win_disk::get_disk_space(drive_path) {
                if total > 0 {
                    // `letter` is the bare drive letter (e.g. "C"); the frontend
                    // renders the localized "Local Disk" label when it is empty.
                    drives.push(SystemDriveInfo {
                        letter: (letter_char as char).to_string(),
                        label: String::new(),
                        total_bytes: total,
                        available_bytes: free,
                        is_ssd: kind_for(letter_char as char),
                    });
                }
            }
        }
    }

    #[cfg(not(windows))]
    {
        // Unix has mount points rather than drive letters. The move dialog is
        // Windows-only (it builds `X:\Games` targets), so this list is only
        // used for reporting real capacity; report the truth instead of a
        // hard-coded placeholder.
        use sysinfo::Disks;

        let mut seen = std::collections::HashSet::new();
        for disk in Disks::new_with_refreshed_list().iter() {
            let mount = disk.mount_point().to_string_lossy().to_string();
            if !seen.insert(mount.clone()) || disk.total_space() == 0 {
                continue;
            }
            let label = disk.name().to_string_lossy().to_string();
            drives.push(SystemDriveInfo {
                letter: mount,
                label,
                total_bytes: disk.total_space(),
                available_bytes: disk.available_space(),
                is_ssd: match disk.kind() {
                    sysinfo::DiskKind::SSD => Some(true),
                    sysinfo::DiskKind::HDD => Some(false),
                    _ => None,
                },
            });
        }
    }

    drives
}

/// Opens the native Windows modern folder picker dialog.
/// `title` is supplied by the frontend so the dialog follows the selected language.
pub async fn select_folder_dialog(
    default_path: Option<String>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let picker_title = title
            .unwrap_or_else(|| "Select Folder".to_string())
            .replace('\'', "''");
        tokio::task::spawn_blocking(move || {
            let clean_default_path = if let Some(p) = default_path {
                p.replace('\'', "''")
            } else {
                String::new()
            };

            let script = format!(
                r#"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
$code = @'
using System;
using System.Runtime.InteropServices;

public class NativeFolderPicker {{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern int SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
        IntPtr pbc,
        [In, MarshalAs(UnmanagedType.LPStruct)] Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

    [ComImport]
    [Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    [CoClass(typeof(FileOpenDialogClass))]
    private interface IFileOpenDialog : IFileDialog {{ }}

    [ComImport]
    [Guid("42f85136-db7e-439c-85f1-e4075d135fc8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog {{
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes();
        void SetFileTypeIndex();
        void GetFileTypeIndex();
        void Advise();
        void Unadvise();
        void SetOptions(uint fos);
        void GetOptions(out uint fos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace();
        void SetDefaultExtension();
        void Close();
        void SetClientGuid();
        void ClearClientData();
        void SetFilter();
    }}

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem {{
        void BindToHandler();
        void GetParent();
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes();
        void Compare();
    }}

    [ComImport]
    [Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    [ClassInterface(ClassInterfaceType.None)]
    private class FileOpenDialogClass {{ }}

    private const uint FOS_PICKFOLDERS = 0x00000020;
    private const uint FOS_FORCEFILESYSTEM = 0x00000040;
    private const uint SIGDN_FILESYSPATH = 0x80058000;

    public static string SelectFolder(string title, string initialDir) {{
        var dialog = (IFileOpenDialog)new FileOpenDialogClass();
        uint options = FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM;
        dialog.SetOptions(options);

        if (!string.IsNullOrEmpty(title)) {{
            dialog.SetTitle(title);
        }}

        string targetDir = initialDir;
        while (!string.IsNullOrEmpty(targetDir) && !System.IO.Directory.Exists(targetDir)) {{
            try {{
                targetDir = System.IO.Path.GetDirectoryName(targetDir);
            }} catch {{
                targetDir = null;
            }}
        }}

        if (!string.IsNullOrEmpty(targetDir) && System.IO.Directory.Exists(targetDir)) {{
            try {{
                IShellItem folderItem;
                Guid iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
                if (SHCreateItemFromParsingName(targetDir, IntPtr.Zero, iid, out folderItem) == 0 && folderItem != null) {{
                    dialog.SetFolder(folderItem);
                }}
            }} catch {{ }}
        }}

        int hr = dialog.Show(IntPtr.Zero);
        if (hr == 0) {{
            IShellItem resultItem;
            dialog.GetResult(out resultItem);
            if (resultItem != null) {{
                string path;
                resultItem.GetDisplayName(SIGDN_FILESYSPATH, out path);
                return path;
            }}
        }}
        return null;
    }}
}}
'@;
Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue;
$chosen = $null;
try {{
    $chosen = [NativeFolderPicker]::SelectFolder('{picker_title}', '{def_path}');
}} catch {{}}
if (-not $chosen) {{
    # Secondary fallback: the Forms dialog in rare cases
    [System.Reflection.Assembly]::LoadWithPartialName('System.windows.forms') | Out-Null;
    $f = New-Object System.Windows.Forms.FolderBrowserDialog;
    $f.Description = '{picker_title}';
    $f.ShowNewFolderButton = $true;
    if (Test-Path '{def_path}') {{ $f.SelectedPath = '{def_path}' }};
    if ($f.ShowDialog() -eq 'OK') {{ $chosen = $f.SelectedPath }};
}}
if ($chosen) {{
    [Console]::WriteLine($chosen);
}}
"#,
                def_path = clean_default_path,
                picker_title = picker_title
            );

            let utf16_bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
            let encoded_cmd = base64::engine::general_purpose::STANDARD.encode(&utf16_bytes);

            use std::os::windows::process::CommandExt;
            let mut cmd = std::process::Command::new("powershell.exe");
            cmd.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded_cmd]);
            cmd.creation_flags(0x08000000);
            let output = cmd
                .output()
                .map_err(|e| format!("@t:move.pickerFailed\u{1f}{}", e))?;

            if output.status.success() {
                let chosen = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !chosen.is_empty() {
                    Ok(Some(chosen))
                } else {
                    Ok(None)
                }
            } else {
                Ok(None)
            }
        })
        .await
        .map_err(|e| format!("@t:move.taskError\u{1f}{}", e))?
    }

    #[cfg(not(windows))]
    {
        use std::process::Command;
        let picked_title = title.unwrap_or_else(|| "Select Folder".to_string());
        if cfg!(target_os = "macos") {
            let escaped = picked_title.replace('\\', "\\\\").replace('"', "\\\"");
            let script = format!("POSIX path of (choose folder with prompt \"{escaped}\")");
            let output = Command::new("osascript")
                .args(["-e", &script])
                .output()
                .map_err(|error| error.to_string())?;
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Ok(if output.status.success() && !path.is_empty() {
                Some(path)
            } else {
                None
            });
        }

        // GNOME's zenity first, KDE's kdialog second. Neither is guaranteed on a
        // minimal box; in that case keep the current value instead of failing.
        let mut zenity = Command::new("zenity");
        zenity.args(["--file-selection", "--directory", "--title", &picked_title]);
        if let Some(default) = default_path.as_deref().filter(|path| !path.is_empty()) {
            zenity.arg(format!("--filename={default}/"));
        }
        if let Ok(output) = zenity.output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Ok(Some(path));
                }
            }
        }

        let mut kdialog = Command::new("kdialog");
        kdialog.args(["--getexistingdirectory", &picked_title]);
        if let Some(default) = default_path.as_deref().filter(|path| !path.is_empty()) {
            kdialog.arg(default);
        }
        if let Ok(output) = kdialog.output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Ok(Some(path));
                }
            }
        }
        Ok(default_path)
    }
}

/// Cancels an active move
pub async fn cancel_move_game(app_name: &str) -> bool {
    let map = get_active_moves().read().await;
    if let Some(flag) = map.get(app_name) {
        flag.store(true, Ordering::SeqCst);
        true
    } else {
        false
    }
}

/// Computes the total file count and byte size at the given path
fn scan_dir_recursive(path: &Path) -> (usize, u64) {
    let mut files = 0;
    let mut bytes = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            // Junctions and symlinks can point outside the game or loop; the
            // copy pass refuses them, so they never count toward the size.
            if file_type.is_symlink() {
                continue;
            }
            let p = entry.path();
            if file_type.is_dir() {
                let (f, b) = scan_dir_recursive(&p);
                files += f;
                bytes += b;
            } else if file_type.is_file() {
                files += 1;
                if let Ok(meta) = entry.metadata() {
                    bytes += meta.len();
                }
            }
        }
    }
    (files, bytes)
}

fn fmt_speed(bps: f64) -> String {
    if bps >= 1024.0 * 1024.0 * 1024.0 {
        format!("{:.1} GB/sn", bps / (1024.0 * 1024.0 * 1024.0))
    } else if bps >= 1024.0 * 1024.0 {
        format!("{:.1} MB/sn", bps / (1024.0 * 1024.0))
    } else if bps >= 1024.0 {
        format!("{:.0} KB/sn", bps / 1024.0)
    } else {
        format!("{:.0} B/sn", bps)
    }
}

fn fmt_eta(seconds: u64) -> String {
    if seconds >= 3600 {
        let h = seconds / 3600;
        let m = (seconds % 3600) / 60;
        format!("~{} sa {} dk", h, m)
    } else if seconds >= 60 {
        let m = seconds / 60;
        let s = seconds % 60;
        format!("~{} dk {} sn", m, s)
    } else {
        format!("~{} sn", seconds)
    }
}

/// Extracts the drive letter (e.g. "C:\Games" -> "C:")
fn get_drive_prefix(path: &Path) -> Option<String> {
    let s = path.to_string_lossy();
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        Some(s[..2].to_uppercase())
    } else {
        None
    }
}

/// Install path of one Amazon product inside Nile's `installed.json` list.
fn nile_installed_path(list: &[serde_json::Value], app_name: &str) -> Option<String> {
    let product_id = app_name.strip_prefix("amazon::").unwrap_or(app_name);
    list.iter()
        .find(|entry| entry.get("id").and_then(|v| v.as_str()) == Some(product_id))
        .and_then(|entry| entry.get("path"))
        .and_then(|v| v.as_str())
        .filter(|p| !p.is_empty())
        .map(|p| p.to_string())
}

/// Rewrites the install path of one Amazon product in Nile's list.
fn set_nile_installed_path(list: &mut [serde_json::Value], app_name: &str, new_path: &str) -> bool {
    let product_id = app_name.strip_prefix("amazon::").unwrap_or(app_name);
    let Some(entry) = list
        .iter_mut()
        .find(|entry| entry.get("id").and_then(|v| v.as_str()) == Some(product_id))
    else {
        return false;
    };
    let Some(obj) = entry.as_object_mut() else {
        return false;
    };
    obj.insert(
        "path".to_string(),
        serde_json::Value::String(new_path.to_string()),
    );
    true
}

/// Which installation record the move has to update when the files land.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum MoveRecord {
    /// Legendary's `installed.json` map (Epic games).
    Epic,
    /// Nile's `installed.json` list (Amazon games).
    Amazon,
}

impl MoveRecord {
    fn as_str(self) -> &'static str {
        match self {
            Self::Epic => "epic",
            Self::Amazon => "amazon",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "epic" => Some(Self::Epic),
            "amazon" => Some(Self::Amazon),
            _ => None,
        }
    }
}

/// A cross-drive move writes through a staging folder. The journal makes the
/// intent visible to the next launch: if the target landed but the record did
/// not, the record is repaired; a half-copied staging folder is removed.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct MoveJournal {
    app_name: String,
    record: String,
    source: String,
    target: String,
    stage: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn move_journal_path(config_dir: &Path) -> PathBuf {
    config_dir.join("efxlve-move-journal.json")
}

fn write_move_journal(config_dir: &Path, journal: &MoveJournal) -> Result<(), String> {
    if let Some(parent) = config_dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let data = serde_json::to_string_pretty(journal).map_err(|e| e.to_string())?;
    std::fs::write(move_journal_path(config_dir), data).map_err(|e| e.to_string())
}

fn clear_move_journal(config_dir: &Path) {
    let _ = std::fs::remove_file(move_journal_path(config_dir));
}

fn stage_folder_name(app_name: &str) -> String {
    let clean: String = app_name
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .take(48)
        .collect();
    format!(".efxlve-move-{clean}-{:x}", now_ms())
}

/// Paths that must never be moved, deleted or used as a destination root.
/// Children are fine: `C:\Program Files\Epic Games\Title` is a real install,
/// while `C:\Program Files` itself is not a game folder.
fn protected_roots() -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    #[cfg(windows)]
    {
        for letter in b'A'..=b'Z' {
            roots.push(format!("{}:\\", letter as char).to_ascii_lowercase());
        }
        for key in ["WINDIR", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"] {
            if let Ok(value) = std::env::var(key) {
                roots.push(normalize_path(Path::new(&value)));
            }
        }
        if let Ok(home) = std::env::var("USERPROFILE") {
            let home = PathBuf::from(home);
            roots.push(normalize_path(&home));
            for sub in [
                "Desktop",
                "Documents",
                "Downloads",
                "Pictures",
                "Videos",
                "Music",
                "AppData",
                "OneDrive",
            ] {
                roots.push(normalize_path(&home.join(sub)));
            }
        }
        if let Ok(public) = std::env::var("PUBLIC") {
            roots.push(normalize_path(Path::new(&public)));
        }
    }
    #[cfg(not(windows))]
    {
        for path in ["/", "/home", "/usr", "/etc", "/var", "/tmp", "/opt", "/boot"] {
            roots.push(normalize_path(Path::new(path)));
        }
        if let Ok(home) = std::env::var("HOME") {
            let home = PathBuf::from(home);
            roots.push(normalize_path(&home));
            for sub in ["Desktop", "Documents", "Downloads"] {
                roots.push(normalize_path(&home.join(sub)));
            }
        }
    }
    roots
}

/// Lowercase, forward slashes folded into backslashes, trailing separators
/// removed. Used only for comparisons, never to build a real path.
fn normalize_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

/// True when the folder itself may be moved. A root, a home folder, a desktop
/// or a symlink is not a game folder even if the record claims it is.
fn folder_is_safe(path: &Path) -> bool {
    if !path.is_absolute() || path.file_name().is_none() {
        return false;
    }
    if std::fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
    {
        return false;
    }
    let key = normalize_path(path);
    !key.is_empty() && !protected_roots().iter().any(|root| root == &key)
}

/// True when one folder contains the other; moving either would move the
/// destination into itself.
fn folders_overlap(left: &Path, right: &Path) -> bool {
    let left = normalize_path(left);
    let right = normalize_path(right);
    if left.is_empty() || right.is_empty() || left == right {
        return left == right;
    }
    left.starts_with(&format!("{right}\\")) || right.starts_with(&format!("{left}\\"))
}

/// Repairs the store record after a move that reached the target but lost the
/// launcher before writing the new path.
fn repair_move_record(config_dir: &Path, journal: &MoveJournal) {
    let Some(record) = MoveRecord::from_str(&journal.record) else {
        return;
    };
    let installed_file = config_dir.join("installed.json");
    let Ok(text) = std::fs::read_to_string(&installed_file) else {
        return;
    };
    match record {
        MoveRecord::Epic => {
            let Ok(mut map) = serde_json::from_str::<HashMap<String, serde_json::Value>>(&text) else {
                return;
            };
            let Some(entry) = map.get_mut(&journal.app_name) else {
                return;
            };
            let Some(object) = entry.as_object_mut() else {
                return;
            };
            object.insert(
                "install_path".to_string(),
                serde_json::Value::String(journal.target.clone()),
            );
            if let Ok(updated) = serde_json::to_string_pretty(&map) {
                let _ = std::fs::write(&installed_file, updated);
            }
        }
        MoveRecord::Amazon => {
            let Ok(mut list) = serde_json::from_str::<Vec<serde_json::Value>>(&text) else {
                return;
            };
            if set_nile_installed_path(&mut list, &journal.app_name, &journal.target) {
                if let Ok(updated) = serde_json::to_string(&list) {
                    let _ = std::fs::write(&installed_file, updated);
                }
            }
        }
    }
}

/// Runs once at startup: finishes the record side of a completed move and
/// removes a staging folder that a crash left behind.
pub fn recover_interrupted_moves(config_dir: &Path) {
    let path = move_journal_path(config_dir);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let journal = match serde_json::from_str::<MoveJournal>(&text) {
        Ok(value) => value,
        Err(_) => {
            let _ = std::fs::remove_file(path);
            return;
        }
    };
    let source = PathBuf::from(&journal.source);
    let target = PathBuf::from(&journal.target);
    let stage = PathBuf::from(&journal.stage);
    let target_has_files = std::fs::read_dir(&target)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false);
    if target_has_files && !source.exists() {
        repair_move_record(config_dir, &journal);
    }
    // Only remove a folder this launcher named; never trust an edited journal
    // with an arbitrary path.
    let stage_is_ours = stage
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(".efxlve-move-"));
    if stage_is_ours && stage.is_dir() {
        let _ = std::fs::remove_dir_all(&stage);
    }
    let _ = std::fs::remove_file(path);
}

/// Moves a game to a new root folder (Epic record format).
pub async fn move_game_folder(
    app: AppHandle,
    config_dir: &Path,
    app_name: String,
    target_base_dir: String,
) -> Result<MoveGameResult, String> {
    move_game_folder_record(app, config_dir, app_name, target_base_dir, MoveRecord::Epic).await
}

/// Moves a game to a new root folder, updating the record format it belongs to.
pub(crate) async fn move_game_folder_record(
    app: AppHandle,
    config_dir: &Path,
    app_name: String,
    target_base_dir: String,
    record: MoveRecord,
) -> Result<MoveGameResult, String> {
    // 1. Register the cancel flag
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut map = get_active_moves().write().await;
        map.insert(app_name.clone(), cancel_flag.clone());
    }

    let result = move_game_folder_internal(
        &app,
        config_dir,
        &app_name,
        &target_base_dir,
        cancel_flag.clone(),
        record,
    )
    .await;

    // Clear the cancel flag
    {
        let mut map = get_active_moves().write().await;
        map.remove(&app_name);
    }

    match &result {
        Ok(res) => {
            let _ = app.emit(
                "move-complete",
                serde_json::json!({
                    "id": app_name,
                    "success": true,
                    "newPath": res.new_path,
                    "message": res.message,
                }),
            );
        }
        Err(err) => {
            let _ = app.emit(
                "move-complete",
                serde_json::json!({
                    "id": app_name,
                    "success": false,
                    "newPath": "",
                    "message": err,
                }),
            );
        }
    }

    result
}

async fn move_game_folder_internal(
    app: &AppHandle,
    config_dir: &Path,
    app_name: &str,
    target_base_dir: &str,
    cancel_flag: Arc<AtomicBool>,
    record: MoveRecord,
) -> Result<MoveGameResult, String> {
    // 1. Read the current install path from the matching install record.
    let installed_file = config_dir.join("installed.json");
    let text = if installed_file.exists() {
        tokio::fs::read_to_string(&installed_file)
            .await
            .map_err(|e| format!("@t:move.installedReadFailed\u{1f}{}", e))?
    } else {
        String::new()
    };

    let mut installed_map: HashMap<String, serde_json::Value> = HashMap::new();
    let mut installed_list: Vec<serde_json::Value> = Vec::new();
    let cur_install_path_str = match record {
        MoveRecord::Epic => {
            installed_map =
                serde_json::from_str::<HashMap<String, serde_json::Value>>(&text).unwrap_or_default();
            installed_map
                .get(app_name)
                .and_then(|entry| entry.get("install_path"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    if installed_map.contains_key(app_name) {
                        "@t:move.noCurrentPath".to_string()
                    } else {
                        format!("@t:move.noInstallRecord\u{1f}{app_name}")
                    }
                })?
                .to_string()
        }
        MoveRecord::Amazon => {
            installed_list = serde_json::from_str::<Vec<serde_json::Value>>(&text).unwrap_or_default();
            nile_installed_path(&installed_list, app_name)
                .ok_or_else(|| format!("@t:move.noInstallRecord\u{1f}{app_name}"))?
        }
    };

    let cur_path = PathBuf::from(&cur_install_path_str);
    if !cur_path.is_dir() {
        return Err(format!("@t:move.folderMissing\u{1f}{}", cur_path.display()));
    }
    if !folder_is_safe(&cur_path) {
        return Err(format!("@t:move.unsafeSource\u{1f}{}", cur_path.display()));
    }

    let folder_name = cur_path
        .file_name()
        .ok_or_else(|| "@t:move.folderNameFailed".to_string())?
        .to_string_lossy()
        .to_string();

    let target_base = PathBuf::from(target_base_dir.trim());
    if !folder_is_safe(&target_base) {
        return Err(format!("@t:move.unsafeTarget\u{1f}{}", target_base.display()));
    }
    let new_game_path = target_base.join(&folder_name);
    if !folder_is_safe(&new_game_path) {
        return Err(format!("@t:move.unsafeTarget\u{1f}{}", new_game_path.display()));
    }

    if cur_path == new_game_path {
        return Err("@t:move.alreadyThere".to_string());
    }
    if folders_overlap(&cur_path, &new_game_path) || folders_overlap(&cur_path, &target_base) {
        return Err("@t:move.overlap".to_string());
    }

    // Avoid conflicts if the target folder already exists and is not empty
    if new_game_path.exists() {
        if let Ok(mut rd) = tokio::fs::read_dir(&new_game_path).await {
            if rd.next_entry().await.ok().flatten().is_some() {
                return Err(format!(
                    "@t:move.targetNotEmpty\u{1f}{}",
                    new_game_path.display()
                ));
            }
        }
    }

    // 2. Size and disk-space check
    let _ = app.emit(
        "move-progress",
        MoveGameProgress {
            id: app_name.to_string(),
            stage: "preparing".to_string(),
            percent: 0.0,
            copied_bytes: 0,
            total_bytes: 0,
            speed: String::new(),
            eta: "@t:common.calculating".to_string(),
            current_file: "@t:move.scanningFiles".to_string(),
            files_copied: 0,
            total_files: 0,
        },
    );

    let cur_path_clone = cur_path.clone();
    let (total_files, total_bytes) =
        tokio::task::spawn_blocking(move || scan_dir_recursive(&cur_path_clone))
            .await
            .map_err(|e| format!("@t:move.scanFailed\u{1f}{}", e))?;

    // 3. Same drive or different drive? A rename on the same volume needs no extra free space.
    let cur_drive = get_drive_prefix(&cur_path);
    let target_drive = get_drive_prefix(&target_base);
    let is_same_drive = match (&cur_drive, &target_drive) {
        (Some(c), Some(t)) => c.eq_ignore_ascii_case(t),
        _ => false,
    };

    // Cross-volume copy needs the game's size free on the destination.
    #[cfg(windows)]
    if !is_same_drive {
        let mut check_path = target_base.clone();
        while !check_path.exists() {
            match check_path.parent() {
                Some(parent) if parent != check_path => check_path = parent.to_path_buf(),
                _ => break,
            }
        }

        if let Some((free_bytes, _)) = win_disk::get_disk_space(&check_path) {
            // A small pad covers the folder metadata, not a second copy of the game.
            let required_bytes = total_bytes.saturating_add(64 * 1024 * 1024);
            if free_bytes < required_bytes {
                return Err(format!(
                    "@t:move.notEnoughSpace\u{1f}{:.1}\u{1f}{:.1}",
                    required_bytes as f64 / (1024.0 * 1024.0 * 1024.0),
                    free_bytes as f64 / (1024.0 * 1024.0 * 1024.0)
                ));
            }
        }
    }

    tokio::fs::create_dir_all(&target_base)
        .await
        .map_err(|e| format!("@t:move.parentDirFailed\u{1f}{}", e))?;

    if is_same_drive {
        // --- SAME DRIVE: instant rename (~0.05s) ---
        // A journal still matters here: a crash after the rename but before
        // installed.json is written would leave the record on the old path.
        write_move_journal(
            config_dir,
            &MoveJournal {
                app_name: app_name.to_string(),
                record: record.as_str().to_string(),
                source: cur_path.to_string_lossy().to_string(),
                target: new_game_path.to_string_lossy().to_string(),
                stage: String::new(),
            },
        )?;
        let _ = app.emit(
            "move-progress",
            MoveGameProgress {
                id: app_name.to_string(),
                stage: "moving".to_string(),
                percent: 50.0,
                copied_bytes: total_bytes / 2,
                total_bytes,
                speed: "@t:move.instant".to_string(),
                eta: "~1 sn".to_string(),
                current_file: "@t:move.movingFolder".to_string(),
                files_copied: total_files,
                total_files,
            },
        );

        // The pre-check allowed an existing empty target; a rename cannot
        // replace it, so remove the empty folder first.
        if new_game_path.exists() {
            let _ = tokio::fs::remove_dir_all(&new_game_path).await;
        }
        if let Err(e) = tokio::fs::rename(&cur_path, &new_game_path).await {
            clear_move_journal(config_dir);
            return Err(format!("@t:move.renameFailed\u{1f}{}", e));
        }
    } else {
        // --- DIFFERENT DRIVE: stage, copy, then rename into place ---
        let start_time = Instant::now();
        let mut copied_bytes: u64 = 0;
        let mut files_copied: usize = 0;

        // Writing straight into the final folder leaves a half game there when
        // the copy is interrupted, and the next attempt refuses the non-empty
        // target. The staging folder plus the journal makes an interrupted run
        // recoverable: the next boot removes the partial copy.
        let stage_path = target_base.join(stage_folder_name(app_name));
        write_move_journal(
            config_dir,
            &MoveJournal {
                app_name: app_name.to_string(),
                record: record.as_str().to_string(),
                source: cur_path.to_string_lossy().to_string(),
                target: new_game_path.to_string_lossy().to_string(),
                stage: stage_path.to_string_lossy().to_string(),
            },
        )?;

        tokio::fs::create_dir_all(&stage_path)
            .await
            .map_err(|e| format!("@t:move.targetDirFailed\u{1f}{}", e))?;

        let copy_res = copy_dir_with_progress(
            app,
            app_name,
            &cur_path,
            &stage_path,
            &cur_path,
            total_bytes,
            total_files,
            &mut copied_bytes,
            &mut files_copied,
            start_time,
            cancel_flag.clone(),
        )
        .await;

        if let Err(e) = copy_res {
            // On cancel or error, clean up the incomplete staging copy.
            let _ = tokio::fs::remove_dir_all(&stage_path).await;
            clear_move_journal(config_dir);
            return Err(e);
        }

        // The target was checked as empty above; make room for the rename.
        if new_game_path.exists() {
            let _ = tokio::fs::remove_dir_all(&new_game_path).await;
        }
        if let Err(e) = tokio::fs::rename(&stage_path, &new_game_path).await {
            let _ = tokio::fs::remove_dir_all(&stage_path).await;
            clear_move_journal(config_dir);
            return Err(format!("@t:move.renameFailed\u{1f}{}", e));
        }

        // Copy complete: safely delete the source folder
        let _ = app.emit(
            "move-progress",
            MoveGameProgress {
                id: app_name.to_string(),
                stage: "cleaning".to_string(),
                percent: 99.0,
                copied_bytes: total_bytes,
                total_bytes,
                speed: String::new(),
                eta: "@t:move.finishing".to_string(),
                current_file: "@t:move.cleaningSource".to_string(),
                files_copied: total_files,
                total_files,
            },
        );

        let _ = tokio::fs::remove_dir_all(&cur_path).await;
    }

    // 4. Update the databases
    let new_path_str = new_game_path.to_string_lossy().to_string();

    match record {
        MoveRecord::Epic => {
            // A) installed.json
            if let Some(entry) = installed_map.get_mut(app_name) {
                if let Some(obj) = entry.as_object_mut() {
                    obj.insert(
                        "install_path".to_string(),
                        serde_json::Value::String(new_path_str.clone()),
                    );
                }
            }
            if let Ok(updated_json) = serde_json::to_string_pretty(&installed_map) {
                let _ = tokio::fs::write(&installed_file, updated_json).await;
            }

            // B) legendary move <app> <target_base> --skip-move
            let bin_path =
                crate::legendary::paths::resolve_binary(app).unwrap_or_else(|_| PathBuf::from("legendary"));

            let mut move_cmd = tokio::process::Command::new(bin_path);
            move_cmd.args([
                "move",
                app_name,
                &target_base.to_string_lossy(),
                "--skip-move",
            ]);
            #[cfg(windows)]
            move_cmd.creation_flags(0x08000000);
            let _ = move_cmd.output().await;

            // C) Epic Games Launcher manifest (.item) update
            update_egl_manifest(app_name, &cur_path, &new_game_path).await;
        }
        MoveRecord::Amazon => {
            // Nile keys its records by product id and reads `path` on launch.
            if set_nile_installed_path(&mut installed_list, app_name, &new_path_str) {
                if let Ok(updated_json) = serde_json::to_string(&installed_list) {
                    let _ = tokio::fs::write(&installed_file, updated_json).await;
                }
            }
        }
    }

    // 5. Emit the completed progress
    clear_move_journal(config_dir);
    let _ = app.emit(
        "move-progress",
        MoveGameProgress {
            id: app_name.to_string(),
            stage: "complete".to_string(),
            percent: 100.0,
            copied_bytes: total_bytes,
            total_bytes,
            speed: String::new(),
            eta: "@t:move.done".to_string(),
            current_file: "@t:move.successDetail".to_string(),
            files_copied: total_files,
            total_files,
        },
    );

    Ok(MoveGameResult {
        success: true,
        new_path: new_path_str,
        message: format!("@t:move.successPath\u{1f}{}", new_game_path.display()),
    })
}

/// Streamed (1 MB buffer) file copy that emits progress
fn copy_dir_with_progress<'a>(
    app: &'a AppHandle,
    app_name: &'a str,
    src_dir: &'a Path,
    dst_dir: &'a Path,
    root_src: &'a Path,
    total_bytes: u64,
    total_files: usize,
    copied_bytes: &'a mut u64,
    files_copied: &'a mut usize,
    start_time: Instant,
    cancel_flag: Arc<AtomicBool>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        let mut entries = tokio::fs::read_dir(src_dir)
            .await
            .map_err(|e| format!("@t:move.readDirFailed\u{1f}{}", e))?;

        let mut last_emit = Instant::now();

        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| format!("@t:move.readInputFailed\u{1f}{}", e))?
        {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err("@t:move.cancelledByUser".to_string());
            }

            let entry_path = entry.path();
            let file_type = entry
                .file_type()
                .await
                .map_err(|e| format!("@t:move.readDirFailed\u{1f}{}", e))?;
            if file_type.is_symlink() {
                // Following it could copy files from outside the game, or loop.
                return Err(format!(
                    "@t:move.symlinkBlocked\u{1f}{}",
                    entry_path.display()
                ));
            }
            let rel_path = entry_path
                .strip_prefix(root_src)
                .map_err(|e| e.to_string())?;
            let target_item_path = dst_dir.join(rel_path);

            if file_type.is_dir() {
                tokio::fs::create_dir_all(&target_item_path)
                    .await
                    .map_err(|e| format!("@t:move.mkdirFailed\u{1f}{}", e))?;
                copy_dir_with_progress(
                    app,
                    app_name,
                    &entry_path,
                    dst_dir,
                    root_src,
                    total_bytes,
                    total_files,
                    copied_bytes,
                    files_copied,
                    start_time,
                    cancel_flag.clone(),
                )
                .await?;
            } else if entry_path.is_file() {
                if let Some(parent) = target_item_path.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }

                let file_name_disp = entry_path
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_default();

                let mut src_file = tokio::fs::File::open(&entry_path).await.map_err(|e| {
                    format!(
                        "@t:move.openSrcFailed\u{1f}{}\u{1f}{}",
                        entry_path.display(),
                        e
                    )
                })?;

                let mut dst_file =
                    tokio::fs::File::create(&target_item_path)
                        .await
                        .map_err(|e| {
                            format!(
                                "@t:move.openDstFailed\u{1f}{}\u{1f}{}",
                                target_item_path.display(),
                                e
                            )
                        })?;

                let mut buf = vec![0u8; 1024 * 1024]; // 1 MB buffer

                loop {
                    if cancel_flag.load(Ordering::Relaxed) {
                        return Err("@t:move.cancelledByUser".to_string());
                    }

                    let n = src_file
                        .read(&mut buf)
                        .await
                        .map_err(|e| format!("@t:move.readFailed\u{1f}{}", e))?;
                    if n == 0 {
                        break;
                    }

                    dst_file
                        .write_all(&buf[..n])
                        .await
                        .map_err(|e| format!("@t:move.writeFailed\u{1f}{}", e))?;

                    *copied_bytes += n as u64;

                    // Emit progress at most 10 times per second (100ms)
                    if last_emit.elapsed().as_millis() > 100 {
                        let elapsed = start_time.elapsed().as_secs_f64();
                        let speed_bps = if elapsed > 0.0 {
                            *copied_bytes as f64 / elapsed
                        } else {
                            0.0
                        };

                        let remaining_bytes = total_bytes.saturating_sub(*copied_bytes);
                        let eta_secs = if speed_bps > 0.0 {
                            (remaining_bytes as f64 / speed_bps) as u64
                        } else {
                            0
                        };

                        let percent = if total_bytes > 0 {
                            (*copied_bytes as f64 / total_bytes as f64) * 100.0
                        } else {
                            100.0
                        };

                        let _ = app.emit(
                            "move-progress",
                            MoveGameProgress {
                                id: app_name.to_string(),
                                stage: "moving".to_string(),
                                percent: (percent * 10.0).round() / 10.0,
                                copied_bytes: *copied_bytes,
                                total_bytes,
                                speed: fmt_speed(speed_bps),
                                eta: fmt_eta(eta_secs),
                                current_file: file_name_disp.clone(),
                                files_copied: *files_copied,
                                total_files,
                            },
                        );

                        last_emit = Instant::now();
                    }
                }

                *files_copied += 1;
            }
        }

        Ok(())
    })
}

/// Updates the path inside Epic Games Launcher .item manifest files
async fn update_egl_manifest(app_name: &str, old_path: &Path, new_path: &Path) {
    let manifests_dir = Path::new(r"C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests");
    if !manifests_dir.is_dir() {
        return;
    }

    let old_path_str = old_path.to_string_lossy().to_string();
    let new_path_str = new_path.to_string_lossy().to_string();

    let mut dir = match tokio::fs::read_dir(manifests_dir).await {
        Ok(d) => d,
        Err(_) => return,
    };

    while let Ok(Some(entry)) = dir.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("item") {
            if let Ok(content) = tokio::fs::read_to_string(&path).await {
                if let Ok(mut json_val) = serde_json::from_str::<serde_json::Value>(&content) {
                    let mut matched = false;
                    if let Some(an) = json_val.get("AppName").and_then(|v| v.as_str()) {
                        if an.eq_ignore_ascii_case(app_name) {
                            matched = true;
                        }
                    }
                    if let Some(il) = json_val.get("InstallLocation").and_then(|v| v.as_str()) {
                        if il.eq_ignore_ascii_case(&old_path_str) {
                            matched = true;
                        }
                    }

                    if matched {
                        if let Some(obj) = json_val.as_object_mut() {
                            obj.insert(
                                "InstallLocation".to_string(),
                                serde_json::Value::String(new_path_str.clone()),
                            );

                            // Update ManifestLocation and CompleteManifestPath if present
                            if let Some(ml) = obj.get("ManifestLocation").and_then(|v| v.as_str()) {
                                let updated_ml = ml.replace(&old_path_str, &new_path_str);
                                obj.insert(
                                    "ManifestLocation".to_string(),
                                    serde_json::Value::String(updated_ml),
                                );
                            }
                            if let Some(cmp) =
                                obj.get("CompleteManifestPath").and_then(|v| v.as_str())
                            {
                                let updated_cmp = cmp.replace(&old_path_str, &new_path_str);
                                obj.insert(
                                    "CompleteManifestPath".to_string(),
                                    serde_json::Value::String(updated_cmp),
                                );
                            }
                        }

                        if let Ok(new_content) = serde_json::to_string_pretty(&json_val) {
                            let _ = tokio::fs::write(&path, new_content).await;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_drive_prefix_parsing() {
        assert_eq!(
            get_drive_prefix(Path::new(r"C:\Program Files\Epic Games\Game")),
            Some("C:".to_string())
        );
        assert_eq!(
            get_drive_prefix(Path::new(r"d:\games\mygame")),
            Some("D:".to_string())
        );
        assert_eq!(get_drive_prefix(Path::new(r"//server/share")), None);
    }

    #[test]
    fn test_speed_and_eta_formatting() {
        assert_eq!(fmt_speed(500.0), "500 B/sn");
        assert_eq!(fmt_speed(15_000.0), "15 KB/sn");
        assert_eq!(fmt_speed(50_000_000.0), "47.7 MB/sn");

        assert_eq!(fmt_eta(45), "~45 sn");
        assert_eq!(fmt_eta(125), "~2 dk 5 sn");
        assert_eq!(fmt_eta(3665), "~1 sa 1 dk");
    }

    #[test]
    fn nile_installed_records_keep_their_shape() {
        let value = serde_json::json!([
            { "id": "amzn1.a", "version": "1", "path": "C:\\Games\\A", "size": 10 },
            { "id": "amzn1.b", "version": "2", "path": "C:\\Games\\B", "size": 20 }
        ]);
        let list = value.as_array().unwrap();
        assert_eq!(
            nile_installed_path(list, "amazon::amzn1.b").as_deref(),
            Some("C:\\Games\\B")
        );
        assert_eq!(nile_installed_path(list, "amazon::missing"), None);

        let mut list = value.clone();
        let list = list.as_array_mut().unwrap();
        assert!(set_nile_installed_path(list, "amazon::amzn1.b", "D:\\Games\\B"));
        assert_eq!(list[1]["path"], "D:\\Games\\B");
        // Other fields of the record must survive the rewrite.
        assert_eq!(list[1]["version"], "2");
        assert_eq!(list[1]["size"], 20);
        assert!(!set_nile_installed_path(list, "amazon::missing", "D:\\X"));
    }

    #[test]
    fn test_system_drives_detection() {
        let drives = get_system_drives();
        println!("{drives:?}");
        // On Windows there must be at least C:
        #[cfg(windows)]
        {
            assert!(!drives.is_empty());
            assert!(drives.iter().any(|d| d.letter == "C"));
        }
    }

    #[test]
    fn path_comparisons_fold_case_and_separators() {
        assert_eq!(normalize_path(Path::new("C:/Games/Title/")), "c:\\games\\title");
        assert!(folders_overlap(
            Path::new("C:\\Games"),
            Path::new("C:\\Games\\Title")
        ));
        assert!(folders_overlap(
            Path::new("C:\\Games\\Title"),
            Path::new("C:\\Games\\Title")
        ));
        assert!(!folders_overlap(
            Path::new("C:\\Games\\Title"),
            Path::new("C:\\Games\\Title 2")
        ));
        assert!(!folders_overlap(
            Path::new("C:\\Games\\Title"),
            Path::new("D:\\Games\\Title")
        ));
    }

    #[test]
    fn roots_and_homes_are_not_game_folders() {
        #[cfg(windows)]
        {
            assert!(!folder_is_safe(Path::new("C:\\")));
            assert!(!folder_is_safe(Path::new("C:\\Windows")));
            let home = std::env::var("USERPROFILE").expect("home");
            assert!(!folder_is_safe(Path::new(&home)));
            assert!(folder_is_safe(
                &Path::new(&home).join("Games").join("Example")
            ));
        }
        #[cfg(not(windows))]
        {
            assert!(!folder_is_safe(Path::new("/")));
            assert!(!folder_is_safe(Path::new("/usr")));
            assert!(folder_is_safe(Path::new("/mnt/games/Example")));
        }
    }

    #[test]
    fn stage_names_stay_inside_the_move_prefix() {
        let name = stage_folder_name("epic::Some Game/With:Bad?Chars");
        assert!(name.starts_with(".efxlve-move-"));
        assert!(!name.contains('/'));
        assert!(!name.contains('\\'));
        assert!(!name.contains(':'));
    }

    #[test]
    fn recovery_repairs_the_record_and_drops_a_stale_stage() {
        let base = std::env::temp_dir().join(format!(
            "efxlve_move_recovery_{}_{:x}",
            std::process::id(),
            now_ms()
        ));
        let config = base.join("config");
        let target = base.join("target");
        let stage = target.join(".efxlve-move-Test-1");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::create_dir_all(&stage).unwrap();
        std::fs::write(stage.join("partial.bin"), b"half").unwrap();
        std::fs::write(target.join("game.exe"), b"game").unwrap();
        let journal = MoveJournal {
            app_name: "TestGame".to_string(),
            record: "epic".to_string(),
            source: base.join("source").to_string_lossy().to_string(),
            target: target.to_string_lossy().to_string(),
            stage: stage.to_string_lossy().to_string(),
        };
        write_move_journal(&config, &journal).unwrap();
        std::fs::write(
            config.join("installed.json"),
            r#"{"TestGame":{"install_path":"C:\\Old","title":"Test"}}"#,
        )
        .unwrap();

        recover_interrupted_moves(&config);

        assert!(!stage.exists(), "the partial staging folder is removed");
        assert!(!move_journal_path(&config).exists(), "the journal is consumed");
        let map: HashMap<String, serde_json::Value> = serde_json::from_str(
            &std::fs::read_to_string(config.join("installed.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            map["TestGame"]["install_path"].as_str(),
            Some(target.to_string_lossy().as_ref())
        );
        assert_eq!(map["TestGame"]["title"], "Test");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn recovery_does_not_touch_a_target_without_a_finished_move() {
        let base = std::env::temp_dir().join(format!(
            "efxlve_move_partial_{}_{:x}",
            std::process::id(),
            now_ms()
        ));
        let config = base.join("config");
        let target = base.join("target");
        let stage = target.join(".efxlve-move-Test-2");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::create_dir_all(&stage).unwrap();
        std::fs::write(stage.join("partial.bin"), b"half").unwrap();
        let journal = MoveJournal {
            app_name: "TestGame".to_string(),
            record: "epic".to_string(),
            source: base.join("source").to_string_lossy().to_string(),
            target: target.to_string_lossy().to_string(),
            stage: stage.to_string_lossy().to_string(),
        };
        write_move_journal(&config, &journal).unwrap();

        recover_interrupted_moves(&config);

        assert!(!stage.exists());
        assert!(!move_journal_path(&config).exists());
        // No target, no record: installed.json must not be invented.
        assert!(!config.join("installed.json").exists());
        let _ = std::fs::remove_dir_all(base);
    }
}
