//! Upscaler DLL management for installed games.
//!
//! The launcher never bundles DLSS, FSR or XeSS binaries. A swap copies a DLL
//! the user selected or explicitly downloaded, keeps the original beside the
//! game file as `<name>.dlsss`, and restores it without a network service.
//! Catalog downloads come from the public DLSS Swapper manifest; the archive,
//! the extracted DLL and its Authenticode signature are all verified first.

mod catalog;
mod download;
mod hash;
mod scan;
mod store;
mod swap;
mod types;
mod version;

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

pub use types::{CatalogEntry, GameUpscalers, ImportedDll, UpscalerDll, UpscalerKind};

static STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    STORE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn upscalers_scan_game(
    install_path: String,
    game_key: String,
) -> Result<GameUpscalers, String> {
    tokio::task::spawn_blocking(move || scan::scan_game(&install_path, &game_key))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn upscalers_list_imported(app: AppHandle) -> Result<Vec<ImportedDll>, String> {
    let root = data_root(&app)?;
    tokio::task::spawn_blocking(move || {
        let _guard = lock();
        store::list_imported(&root)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn upscalers_import_dll(
    app: AppHandle,
    path: String,
) -> Result<ImportedDll, String> {
    let root = data_root(&app)?;
    tokio::task::spawn_blocking(move || {
        let _guard = lock();
        store::import_dll(&root, std::path::Path::new(&path))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn upscalers_catalog(
    app: AppHandle,
    force: bool,
) -> Result<Vec<CatalogEntry>, String> {
    let root = data_root(&app)?;
    catalog::load_catalog(&root, force).await
}

async fn download_and_swap(
    app_data: PathBuf,
    install_path: String,
    dll_path: String,
    entry: CatalogEntry,
) -> Result<UpscalerDll, String> {
    download::ensure_cached(&app_data, &entry).await?;

    let record_root = app_data.clone();
    let record_entry = entry.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = lock();
        store::record_cached(
            &record_root,
            record_entry.kind,
            &record_entry.md5,
            &record_entry.version,
            record_entry.kind.file_name(),
            record_entry.file_size,
            &record_entry.download_url,
        )
    })
    .await
    .map_err(|error| error.to_string())??;

    let imported_id = store::id_for(entry.kind, &entry.md5);
    tokio::task::spawn_blocking(move || {
        let _guard = lock();
        swap::swap_dll(&app_data, &install_path, &dll_path, &imported_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// One-click download of the newest signed stable version for this DLL family.
#[tauri::command]
pub async fn upscalers_download_latest(
    app: AppHandle,
    install_path: String,
    dll_path: String,
    kind: UpscalerKind,
) -> Result<UpscalerDll, String> {
    let root = data_root(&app)?;
    let entry = catalog::latest(&root, kind).await?;
    download_and_swap(root, install_path, dll_path, entry).await
}

/// Downloads a specific catalog version selected by its MD5.
#[tauri::command]
pub async fn upscalers_download_swap(
    app: AppHandle,
    install_path: String,
    dll_path: String,
    kind: UpscalerKind,
    md5: String,
) -> Result<UpscalerDll, String> {
    let root = data_root(&app)?;
    let entries = catalog::load_catalog(&root, false).await?;
    let entry = entries
        .into_iter()
        .find(|entry| entry.kind == kind && entry.md5.eq_ignore_ascii_case(&md5))
        .ok_or_else(|| "That catalog version is no longer available.".to_string())?;
    download_and_swap(root, install_path, dll_path, entry).await
}

#[tauri::command]
pub async fn upscalers_swap(
    app: AppHandle,
    install_path: String,
    dll_path: String,
    imported_id: String,
) -> Result<UpscalerDll, String> {
    let root = data_root(&app)?;
    tokio::task::spawn_blocking(move || {
        let _guard = lock();
        swap::swap_dll(&root, &install_path, &dll_path, &imported_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn upscalers_restore(
    install_path: String,
    dll_path: String,
) -> Result<UpscalerDll, String> {
    tokio::task::spawn_blocking(move || swap::restore_dll(&install_path, &dll_path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn upscalers_discard_backup(
    install_path: String,
    dll_path: String,
) -> Result<UpscalerDll, String> {
    tokio::task::spawn_blocking(move || swap::discard_backup(&install_path, &dll_path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn upscalers_pick_dll(title: Option<String>) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let picker_title = title
            .unwrap_or_else(|| "Select a DLL".to_string())
            .replace('\'', "''");
        tokio::task::spawn_blocking(move || {
            let script = format!(
                r#"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
Add-Type -AssemblyName System.Windows.Forms;
$f = New-Object System.Windows.Forms.OpenFileDialog;
$f.Title = '{picker_title}';
$f.Filter = 'DLL files (*.dll)|*.dll|All files (*.*)|*.*';
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
    Write-Output $f.FileName
}}
"#
            );

            let mut command = std::process::Command::new("powershell");
            command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            let output = command.output().map_err(|error| error.to_string())?;
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if stdout.is_empty() {
                Ok(None)
            } else {
                Ok(Some(stdout))
            }
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = title;
        Ok(None)
    }
}
