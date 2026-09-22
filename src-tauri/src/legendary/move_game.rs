use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemDriveInfo {
    pub letter: String,
    pub label: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
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
        fn GetDiskFreeSpaceExW(
            lpDirectoryName: *const u16,
            lpFreeBytesAvailableToCaller: *mut u64,
            lpTotalNumberOfBytes: *mut u64,
            lpTotalNumberOfFreeBytes: *mut u64,
        ) -> i32;
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
            Some((free_available, total_bytes))
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
        for letter_char in b'C'..=b'Z' {
            let drive_str = format!("{}:\\", letter_char as char);
            let drive_path = Path::new(&drive_str);
            if let Some((free, total)) = win_disk::get_disk_space(drive_path) {
                if total > 0 {
                    // `letter` is the bare drive letter (e.g. "C"); the frontend
                    // renders the localized "Local Disk" label when it is empty.
                    drives.push(SystemDriveInfo {
                        letter: (letter_char as char).to_string(),
                        label: String::new(),
                        total_bytes: total,
                        available_bytes: free,
                    });
                }
            }
        }
    }

    #[cfg(not(windows))]
    {
        drives.push(SystemDriveInfo {
            letter: "/".to_string(),
            label: "@t:move.rootDir".to_string(),
            total_bytes: 500_000_000_000,
            available_bytes: 250_000_000_000,
        });
    }

    drives
}

/// Opens the native Windows modern folder picker dialog.
/// `title` is supplied by the frontend so the dialog follows the selected language.
pub async fn select_folder_dialog(default_path: Option<String>, title: Option<String>) -> Result<Option<String>, String> {
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

            let output = std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded_cmd])
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
            let p = entry.path();
            if p.is_dir() {
                let (f, b) = scan_dir_recursive(&p);
                files += f;
                bytes += b;
            } else if p.is_file() {
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

/// Moves a game to a new root folder
pub async fn move_game_folder(
    app: AppHandle,
    config_dir: &Path,
    app_name: String,
    target_base_dir: String,
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
    )
    .await;

    // Temizle
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
) -> Result<MoveGameResult, String> {
    // 1. Oyunun mevcut kurulu yolunu oku
    let installed_file = config_dir.join("installed.json");
    let mut installed_map = if installed_file.exists() {
        let text = tokio::fs::read_to_string(&installed_file)
            .await
            .map_err(|e| format!("@t:move.installedReadFailed\u{1f}{}", e))?;
        serde_json::from_str::<HashMap<String, serde_json::Value>>(&text).unwrap_or_default()
    } else {
        HashMap::new()
    };

    let game_entry = installed_map
        .get_mut(app_name)
        .ok_or_else(|| format!("@t:move.noInstallRecord\u{1f}{app_name}"))?;

    let cur_install_path_str = game_entry
        .get("install_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "@t:move.noCurrentPath".to_string())?
        .to_string();

    let cur_path = PathBuf::from(&cur_install_path_str);
    if !cur_path.is_dir() {
        return Err(format!(
            "@t:move.folderMissing\u{1f}{}",
            cur_path.display()
        ));
    }

    let folder_name = cur_path
        .file_name()
        .ok_or_else(|| "@t:move.folderNameFailed".to_string())?
        .to_string_lossy()
        .to_string();

    let target_base = PathBuf::from(target_base_dir.trim());
    let new_game_path = target_base.join(&folder_name);

    if cur_path == new_game_path {
        return Err("@t:move.alreadyThere".to_string());
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

    // Target drive free-space check
    #[cfg(windows)]
    {
        let check_path = if target_base.exists() {
            target_base.clone()
        } else {
            target_base
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| target_base.clone())
        };

        if let Some((free_bytes, _)) = win_disk::get_disk_space(&check_path) {
            let required_bytes = total_bytes + 500_000_000; // 500 MB safety buffer
            if free_bytes < required_bytes {
                return Err(format!(
                    "@t:move.notEnoughSpace\u{1f}{:.1}\u{1f}{:.1}",
                    required_bytes as f64 / (1024.0 * 1024.0 * 1024.0),
                    free_bytes as f64 / (1024.0 * 1024.0 * 1024.0)
                ));
            }
        }
    }

    // 3. Same drive or different drive?
    let cur_drive = get_drive_prefix(&cur_path);
    let target_drive = get_drive_prefix(&target_base);
    let is_same_drive = match (&cur_drive, &target_drive) {
        (Some(c), Some(t)) => c.eq_ignore_ascii_case(t),
        _ => false,
    };

    tokio::fs::create_dir_all(&target_base)
        .await
        .map_err(|e| format!("@t:move.parentDirFailed\u{1f}{}", e))?;

    if is_same_drive {
        // --- SAME DRIVE: instant rename (~0.05s) ---
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

        tokio::fs::rename(&cur_path, &new_game_path)
            .await
            .map_err(|e| format!("@t:move.renameFailed\u{1f}{}", e))?;
    } else {
        // --- DIFFERENT DRIVE: streamed copy + progress + cancel ---
        let start_time = Instant::now();
        let mut copied_bytes: u64 = 0;
        let mut files_copied: usize = 0;

        tokio::fs::create_dir_all(&new_game_path)
            .await
            .map_err(|e| format!("@t:move.targetDirFailed\u{1f}{}", e))?;

        let copy_res = copy_dir_with_progress(
            app,
            app_name,
            &cur_path,
            &new_game_path,
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
            // On cancel or error, clean up incomplete files at the target
            let _ = tokio::fs::remove_dir_all(&new_game_path).await;
            return Err(e);
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
                current_file: "Eski konum temizleniyor…".to_string(),
                files_copied: total_files,
                total_files,
            },
        );

        let _ = tokio::fs::remove_dir_all(&cur_path).await;
    }

    // 4. Update the databases
    let new_path_str = new_game_path.to_string_lossy().to_string();

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
    let settings = crate::load_settings(app);
    let bin_path = crate::legendary::paths::resolve_binary(app, settings.alt_legendary_bin.as_deref())
        .unwrap_or_else(|_| PathBuf::from("legendary"));

    let _ = tokio::process::Command::new(bin_path)
        .args([
            "move",
            app_name,
            &target_base.to_string_lossy(),
            "--skip-move",
        ])
        .output()
        .await;

    // C) Epic Games Launcher manifest (.item) update
    update_egl_manifest(app_name, &cur_path, &new_game_path).await;

    // 5. Emit the completed progress
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
        message: format!(
            "@t:move.successPath\u{1f}{}",
            new_game_path.display()
        ),
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
            let rel_path = entry_path
                .strip_prefix(root_src)
                .map_err(|e| e.to_string())?;
            let target_item_path = dst_dir.join(rel_path);

            if entry_path.is_dir() {
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

                let mut src_file = tokio::fs::File::open(&entry_path)
                    .await
                    .map_err(|e| format!("@t:move.openSrcFailed\u{1f}{}\u{1f}{}", entry_path.display(), e))?;

                let mut dst_file = tokio::fs::File::create(&target_item_path)
                    .await
                    .map_err(|e| {
                        format!("@t:move.openDstFailed\u{1f}{}\u{1f}{}", target_item_path.display(), e)
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
    fn test_system_drives_detection() {
        let drives = get_system_drives();
        // On Windows there must be at least C:
        #[cfg(windows)]
        {
            assert!(!drives.is_empty());
            assert!(drives.iter().any(|d| d.letter == "C"));
        }
    }
}
