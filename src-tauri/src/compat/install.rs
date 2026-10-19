//! Compatibility runtime manager: catalogue, release check, download,
//! extraction, removal and the settings IPC.
//!
//! The manager is platform neutral: with a `target` such as `linux-x86_64` it
//! can prepare another platform's tree from a Windows build, which is how the
//! Linux/macOS work can be staged before those bundles exist. Launching always
//! uses the tree for the running platform (`launch.rs`).
//!
//! Downloads go to `<app_data>/compat/<os>-<arch>/<tool>/<tag>`, are verified
//! against the digest GitHub publishes when there is one, and are unpacked
//! behind a path check so an archive cannot write outside its own folder.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use super::catalog::{self, ArchiveKind, CachedAsset, CachedRelease, Target, ToolDef, ToolSource};

/// Six hours between automatic release checks; a manual refresh ignores it.
const RELEASE_TTL_SECS: u64 = 6 * 60 * 60;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatInstalled {
    pub tag: String,
    pub path: String,
    pub size: u64,
    pub installed_at: u64,
    pub asset: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatLatest {
    pub tag: String,
    pub asset: String,
    pub size: u64,
    pub release_url: String,
    pub digest: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatToolInfo {
    pub id: String,
    pub repo: String,
    pub homepage: String,
    pub kind: String,
    pub platforms: Vec<String>,
    pub supported: bool,
    pub installable: bool,
    pub removable: bool,
    /// `module`, `github` or `external`.
    pub source: String,
    pub installed: Vec<CompatInstalled>,
    pub detected: Vec<String>,
    pub latest: Option<CompatLatest>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatCatalog {
    pub target: String,
    pub os: String,
    pub arch: String,
    pub current_os: String,
    pub current_arch: String,
    pub cache_age_seconds: Option<u64>,
    pub stale: bool,
    pub tools: Vec<CompatToolInfo>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompatProgress {
    id: String,
    phase: String,
    percent: u8,
    downloaded: u64,
    total: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct ReleaseCache {
    entries: HashMap<String, CachedRelease>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallManifest {
    id: String,
    tag: String,
    asset: String,
    size: u64,
    digest: Option<String>,
    installed_at: u64,
}

fn installing() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

fn cancelled() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_installing(id: &str) -> bool {
    installing()
        .lock()
        .map(|set| set.contains(id))
        .unwrap_or(false)
}

fn is_cancelled(id: &str) -> bool {
    cancelled()
        .lock()
        .map(|set| set.contains(id))
        .unwrap_or(false)
}

/// Removes the "installing" mark even when a download fails or is cancelled.
struct InstallGuard(String);

impl Drop for InstallGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = installing().lock() {
            set.remove(&self.0);
        }
        if let Ok(mut set) = cancelled().lock() {
            set.remove(&self.0);
        }
    }
}

pub fn compat_root(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("compat")
}

fn target_root(app: &AppHandle, target: &Target) -> PathBuf {
    compat_root(app).join(target.key())
}

fn tool_root(app: &AppHandle, target: &Target, id: &str) -> PathBuf {
    target_root(app, target).join(id)
}

fn cache_file(app: &AppHandle) -> PathBuf {
    compat_root(app).join("releases.json")
}

fn now_secs() -> u64 {
    catalog::now_secs()
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn file_mtime(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

fn read_cache(app: &AppHandle) -> ReleaseCache {
    std::fs::read_to_string(cache_file(app))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_cache(app: &AppHandle, cache: &ReleaseCache) {
    let path = cache_file(app);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(text) = serde_json::to_string_pretty(cache) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, text).is_ok() && std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

fn emit_progress(app: &AppHandle, id: &str, phase: &str, percent: u8, downloaded: u64, total: u64) {
    let _ = app.emit(
        "compat-progress",
        CompatProgress {
            id: id.to_string(),
            phase: phase.to_string(),
            percent,
            downloaded,
            total,
        },
    );
}

async fn fetch_latest(repo: &str) -> Result<Option<CachedRelease>, String> {
    if repo.is_empty() {
        return Ok(None);
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(format!(
            "https://api.github.com/repos/{repo}/releases/latest"
        ))
        .header("User-Agent", "efxlve-launcher")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("@t:compat.network\u{1f}{error}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        // A repository without published releases (winecx is one) is not an
        // error: the row simply stays on "detected only".
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!(
            "@t:compat.http\u{1f}{}",
            response.status().as_u16()
        ));
    }
    let release: catalog::GhRelease = response
        .json()
        .await
        .map_err(|error| format!("@t:compat.badRelease\u{1f}{error}"))?;
    Ok(Some(release.into()))
}

async fn refresh_releases(
    app: &AppHandle,
    target: &Target,
    cache: &mut ReleaseCache,
) -> Result<(), String> {
    let mut first_error = None;
    let mut any = false;
    for tool in catalog::TOOLS {
        if tool.source != ToolSource::Github || !target.supports(tool) || tool.repo.is_empty() {
            continue;
        }
        match fetch_latest(tool.repo).await {
            Ok(Some(release)) => {
                cache.entries.insert(tool.id.to_string(), release);
                any = true;
            }
            Ok(None) => {}
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        // Unauthenticated GitHub allows 60 requests an hour; spacing the pass
        // also keeps the settings page responsive while it loads.
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
    write_cache(app, cache);
    if !any {
        if let Some(error) = first_error {
            return Err(error);
        }
    }
    Ok(())
}

fn module_binary(app: &AppHandle, id: &str) -> Option<PathBuf> {
    match id {
        "legendary" => crate::legendary::paths::resolve_binary(app).ok(),
        "gogdl" => crate::gogdl::paths::resolve_binary(app).ok(),
        "nile" => crate::nile::resolve_binary(app),
        "comet" => crate::comet::resolve_binary(app),
        _ => None,
    }
}

fn module_installed(app: &AppHandle, def: &ToolDef) -> Vec<CompatInstalled> {
    module_binary(app, def.id)
        .map(|path| {
            vec![CompatInstalled {
                tag: "managed".to_string(),
                path: path.display().to_string(),
                size: std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0),
                installed_at: file_mtime(&path),
                asset: String::new(),
            }]
        })
        .unwrap_or_default()
}

fn read_manifest(dir: &Path) -> Option<InstallManifest> {
    let text = std::fs::read_to_string(dir.join("manifest.json")).ok()?;
    serde_json::from_str(&text).ok()
}

fn scan_installed(app: &AppHandle, target: &Target, def: &ToolDef) -> Vec<CompatInstalled> {
    let root = tool_root(app, target, def.id);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let tag = entry.file_name().to_string_lossy().to_string();
        if tag.starts_with('.') {
            continue;
        }
        let manifest = read_manifest(&path);
        out.push(CompatInstalled {
            tag,
            size: manifest.as_ref().map(|value| value.size).unwrap_or(0),
            installed_at: manifest
                .as_ref()
                .map(|value| value.installed_at)
                .unwrap_or_else(|| file_mtime(&path)),
            asset: manifest.map(|value| value.asset).unwrap_or_default(),
            path: path.display().to_string(),
        });
    }
    out.sort_by(|a, b| b.installed_at.cmp(&a.installed_at));
    out
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

fn compat_dirs() -> Vec<PathBuf> {
    let home = home_dir();
    let mut dirs = vec![
        home.join(".steam/steam/compatibilitytools.d"),
        home.join(".steam/root/compatibilitytools.d"),
        home.join(".local/share/Steam/compatibilitytools.d"),
        home.join("Library/Application Support/Steam/compatibilitytools.d"),
        home.join(".config/efxlve/tools"),
        home.join(".local/share/lutris/runners/wine"),
    ];
    if cfg!(target_os = "linux") {
        dirs.push(PathBuf::from("/usr/share/steam/compatibilitytools.d"));
        dirs.push(PathBuf::from("/usr/local/share/steam/compatibilitytools.d"));
    }
    dirs
}

fn detect_system(def: &ToolDef) -> Vec<String> {
    let home = home_dir();
    let mut out: Vec<String> = Vec::new();
    let mut push = |path: PathBuf| {
        if path.exists() {
            out.push(path.display().to_string());
        }
    };

    match def.id {
        "ge-proton" | "proton-cachyos" | "wine-staging" | "umu-launcher" => {
            for dir in compat_dirs() {
                let Ok(entries) = std::fs::read_dir(&dir) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_dir() {
                        continue;
                    }
                    let name = entry.file_name().to_string_lossy().to_lowercase();
                    let matches = match def.id {
                        "ge-proton" => {
                            path.join("proton").is_file()
                                && (name.contains("ge-proton") || name.contains("proton-ge"))
                        }
                        "proton-cachyos" => {
                            path.join("proton").is_file() && name.contains("cachyos")
                        }
                        "wine-staging" => {
                            (path.join("bin/wine64").is_file() || path.join("bin/wine").is_file())
                                && (name.contains("wine") || name.contains("staging"))
                        }
                        "umu-launcher" => path.join("umu-run").is_file(),
                        _ => false,
                    };
                    if matches {
                        out.push(path.display().to_string());
                    }
                }
            }
            if def.id == "umu-launcher" {
                if let Some(path) = which("umu-run") {
                    out.push(path.display().to_string());
                }
            }
        }
        "wine-crossover" => {
            push(PathBuf::from("/Applications/CrossOver.app"));
            push(home.join("Applications/CrossOver.app"));
            push(home.join("Library/Application Support/CrossOver/Bottles"));
        }
        "game-porting-toolkit" => {
            for base in [PathBuf::from("/Applications"), home.join("Applications")] {
                let Ok(entries) = std::fs::read_dir(base) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_lowercase();
                    if name.contains("game porting toolkit") || name.contains("gptk") {
                        push(entry.path());
                    }
                }
            }
        }
        "vulkan-helper-rs" => {
            if let Some(path) = which("vulkan-helper") {
                out.push(path.display().to_string());
            }
        }
        _ => {}
    }

    out.sort();
    out.dedup();
    out
}

fn latest_for(cache: &ReleaseCache, def: &ToolDef, target: &Target) -> Option<CompatLatest> {
    let release = cache.entries.get(def.id)?;
    let asset = catalog::select_asset(def.id, &target.arch, &release.assets)?;
    Some(CompatLatest {
        tag: release.tag.clone(),
        asset: asset.name.clone(),
        size: asset.size,
        release_url: release.release_url.clone(),
        digest: asset.digest.clone(),
    })
}

pub async fn build_catalog(
    app: &AppHandle,
    target: &Target,
    refresh: bool,
) -> Result<CompatCatalog, String> {
    let mut cache = read_cache(app);
    let mut refresh_error = None;
    if refresh {
        if let Err(error) = refresh_releases(app, target, &mut cache).await {
            refresh_error = Some(error);
        }
    }

    let mut tools = Vec::with_capacity(catalog::TOOLS.len());
    for def in catalog::TOOLS {
        let supported = target.supports(def);
        let installed = match def.source {
            ToolSource::Module if target.is_current() => module_installed(app, def),
            ToolSource::Module => Vec::new(),
            _ => scan_installed(app, target, def),
        };
        let latest = if def.source == ToolSource::Github && supported {
            latest_for(&cache, def, target)
        } else {
            None
        };
        let installable = match def.source {
            ToolSource::Module => supported && target.is_current() && installed.is_empty(),
            ToolSource::Github => {
                supported
                    && latest.as_ref().is_some_and(|release| {
                        !installed.iter().any(|entry| entry.tag == release.tag)
                    })
            }
            ToolSource::External => false,
        };
        let removable = def.source == ToolSource::Github && !installed.is_empty();
        let detected = if target.is_current() {
            detect_system(def)
        } else {
            Vec::new()
        };
        tools.push(CompatToolInfo {
            id: def.id.to_string(),
            repo: def.repo.to_string(),
            homepage: def.homepage.to_string(),
            kind: def.kind.to_string(),
            platforms: def
                .platforms
                .iter()
                .map(|value| value.to_string())
                .collect(),
            supported,
            installable,
            removable,
            source: match def.source {
                ToolSource::Module => "module".to_string(),
                ToolSource::Github => "github".to_string(),
                ToolSource::External => "external".to_string(),
            },
            installed,
            detected,
            latest,
        });
    }

    let cache_age_seconds = catalog::TOOLS
        .iter()
        .filter(|tool| tool.source == ToolSource::Github && target.supports(tool))
        .filter_map(|tool| cache.entries.get(tool.id))
        .map(|release| now_secs().saturating_sub(release.fetched_at))
        .min();
    let stale = tools.iter().any(|tool| {
        tool.source == "github"
            && tool.supported
            && (tool.latest.is_none()
                || cache_age_seconds
                    .map(|age| age > RELEASE_TTL_SECS)
                    .unwrap_or(true))
    });

    if refresh && tools.iter().all(|tool| tool.latest.is_none()) {
        if let Some(error) = refresh_error {
            return Err(error);
        }
    }

    let current = Target::current();
    Ok(CompatCatalog {
        target: target.key(),
        os: target.os.clone(),
        arch: target.arch.clone(),
        current_os: current.os,
        current_arch: current.arch,
        cache_age_seconds,
        stale,
        tools,
    })
}

async fn ensure_module(app: &AppHandle, id: &str) -> Result<(), String> {
    match id {
        "legendary" => crate::legendary::downloader::ensure_binary(app)
            .await
            .map(|_| ())
            .map_err(crate::legendary::cmd_error),
        "gogdl" => crate::gogdl::paths::ensure_binary(app)
            .await
            .map(|_| ())
            .map_err(crate::gogdl::cmd_error),
        "nile" => crate::nile::ensure_binary(app).await.map(|_| ()),
        "comet" => crate::comet::ensure_binary(app).await.map(|_| ()),
        _ => Err("@t:compat.unknownTool".to_string()),
    }
}

/// A release tag becomes one folder name. Git allows slashes in tags; the
/// install tree does not, and a tag must never add a path segment of its own.
fn safe_tag(tag: &str) -> String {
    let value: String = tag
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '+') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if value.is_empty() || value.chars().all(|ch| ch == '.') {
        "release".to_string()
    } else {
        value
    }
}

fn digest_hex(digest: &Option<String>) -> Option<String> {
    let value = digest.as_deref()?.trim();
    let hex = value.strip_prefix("sha256:").unwrap_or(value);
    (hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit())).then(|| hex.to_lowercase())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// A finished `.part` must match the published size and, when GitHub gave one,
/// the SHA-256. This also validates a part left by an earlier interrupted run.
async fn verify_part(part: &Path, asset: &CachedAsset) -> Result<(), String> {
    if asset.size > 0 {
        let length = tokio::fs::metadata(part)
            .await
            .map_err(|error| error.to_string())?
            .len();
        if length != asset.size {
            return Err("@t:compat.checksum".to_string());
        }
    }
    if let Some(expected) = digest_hex(&asset.digest) {
        let path = part.to_path_buf();
        let actual = tauri::async_runtime::spawn_blocking(move || sha256_file(&path))
            .await
            .map_err(|error| error.to_string())??;
        if actual != expected {
            return Err("@t:compat.checksum".to_string());
        }
    }
    Ok(())
}

async fn download_asset(
    app: &AppHandle,
    id: &str,
    asset: &CachedAsset,
    part: &Path,
) -> Result<(), String> {
    if is_cancelled(id) {
        return Err("@t:compat.cancelled".to_string());
    }
    if let Some(parent) = part.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }

    // A half-gigabyte runner used to restart from byte zero after a dropped
    // connection. The `.part` file is kept on network failures and continued
    // with a Range request; a complete part is verified and reused.
    let mut existing = tokio::fs::metadata(part)
        .await
        .map(|meta| meta.len())
        .unwrap_or(0);
    if asset.size > 0 && existing >= asset.size {
        if existing == asset.size && verify_part(part, asset).await.is_ok() {
            emit_progress(app, id, "download", 100, existing, asset.size);
            return Ok(());
        }
        let _ = tokio::fs::remove_file(part).await;
        existing = 0;
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        // A GE-Proton archive is over half a gigabyte; the timeout is a stall
        // guard, not a download limit.
        .timeout(Duration::from_secs(60 * 60))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client
        .get(&asset.url)
        .header("User-Agent", "efxlve-launcher");
    if existing > 0 {
        request = request.header("Range", format!("bytes={existing}-"));
    }
    let mut response = request
        .send()
        .await
        .map_err(|error| format!("@t:compat.network\u{1f}{error}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE
        && asset.size > 0
        && existing == asset.size
    {
        if verify_part(part, asset).await.is_ok() {
            emit_progress(app, id, "download", 100, existing, asset.size);
            return Ok(());
        }
        let _ = tokio::fs::remove_file(part).await;
        return Err("@t:compat.checksum".to_string());
    }
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        let _ = tokio::fs::remove_file(part).await;
        return Err("@t:compat.checksum".to_string());
    }
    if !status.is_success() {
        return Err(format!("@t:compat.http\u{1f}{}", status.as_u16()));
    }

    let resuming = status == reqwest::StatusCode::PARTIAL_CONTENT && existing > 0;
    let mut downloaded = if resuming { existing } else { 0 };
    let total = if asset.size > 0 {
        asset.size
    } else if resuming {
        existing.saturating_add(response.content_length().unwrap_or(0))
    } else {
        response.content_length().unwrap_or(0)
    };
    let mut file = if resuming {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(part)
            .await
            .map_err(|error| error.to_string())?
    } else {
        // The server ignored the range (or this is a fresh download): start over.
        tokio::fs::File::create(part)
            .await
            .map_err(|error| error.to_string())?
    };
    use tokio::io::AsyncWriteExt;
    let mut last_emit = Instant::now();
    let mut last_percent = 255u8;
    loop {
        if is_cancelled(id) {
            drop(file);
            // Keep the part: a later install continues from here.
            return Err("@t:compat.cancelled".to_string());
        }
        match response.chunk().await {
            Err(error) => {
                drop(file);
                // Keep the part for the next attempt.
                return Err(format!("@t:compat.network\u{1f}{error}"));
            }
            Ok(None) => break,
            Ok(Some(chunk)) => {
                file.write_all(&chunk)
                    .await
                    .map_err(|error| error.to_string())?;
                downloaded = downloaded.saturating_add(chunk.len() as u64);
                let percent = if total > 0 {
                    (downloaded.saturating_mul(100) / total).min(100) as u8
                } else {
                    0
                };
                if percent != last_percent || last_emit.elapsed() >= Duration::from_millis(300) {
                    last_percent = percent;
                    last_emit = Instant::now();
                    emit_progress(app, id, "download", percent, downloaded, total);
                }
            }
        }
    }
    file.flush().await.map_err(|error| error.to_string())?;
    drop(file);

    if let Err(error) = verify_part(part, asset).await {
        let _ = tokio::fs::remove_file(part).await;
        return Err(error);
    }
    emit_progress(app, id, "download", 100, downloaded, total);
    Ok(())
}

/// An archive entry may only land inside the extraction folder.
fn safe_entry_path(path: &Path) -> bool {
    !path.is_absolute()
        && !path.has_root()
        && !path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
}

fn unpack_tar<R: Read>(reader: R, dest: &Path) -> Result<(), String> {
    let mut archive = tar::Archive::new(reader);
    let entries = archive.entries().map_err(|error| error.to_string())?;
    for entry in entries {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let path = entry
            .path()
            .map_err(|error| error.to_string())?
            .into_owned();
        if !safe_entry_path(&path) {
            continue;
        }
        entry.unpack_in(dest).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn extract_archive(archive: &Path, kind: ArchiveKind, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|error| error.to_string())?;
    match kind {
        ArchiveKind::TarGz => unpack_tar(flate2::read::GzDecoder::new(file), dest),
        ArchiveKind::TarXz => unpack_tar(xz2::read::XzDecoder::new(file), dest),
        ArchiveKind::TarZst => {
            let decoder =
                zstd::stream::read::Decoder::new(file).map_err(|error| error.to_string())?;
            unpack_tar(decoder, dest)
        }
        ArchiveKind::Tar => unpack_tar(file, dest),
        ArchiveKind::Plain => Err("not an archive".to_string()),
    }
}

fn single_child_dir(dir: &Path) -> Option<PathBuf> {
    let mut entries = std::fs::read_dir(dir).ok()?.flatten();
    let first = entries.next()?.path();
    if entries.next().is_some() || !first.is_dir() {
        return None;
    }
    Some(first)
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|error| error.to_string())?;
    for entry in std::fs::read_dir(from)
        .map_err(|error| error.to_string())?
        .flatten()
    {
        let source = entry.path();
        let target = to.join(entry.file_name());
        if source.is_dir() {
            copy_dir(&source, &target)?;
        } else {
            std::fs::copy(&source, &target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn promote(temp: &Path, dest: &Path) -> Result<(), String> {
    let source = single_child_dir(temp).unwrap_or_else(|| temp.to_path_buf());
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if dest.exists() {
        return Err("@t:compat.alreadyInstalled".to_string());
    }
    match std::fs::rename(&source, dest) {
        Ok(()) => {
            if source != temp {
                let _ = std::fs::remove_dir_all(temp);
            }
            Ok(())
        }
        Err(_) => {
            copy_dir(&source, dest)?;
            let _ = std::fs::remove_dir_all(temp);
            Ok(())
        }
    }
}

#[cfg(unix)]
fn mark_executables(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut mark = |path: &Path| {
        if path.is_file() {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
        }
    };
    mark(&dir.join("proton"));
    mark(&dir.join("umu-run"));
    if let Ok(entries) = std::fs::read_dir(dir.join("bin")) {
        for entry in entries.flatten() {
            mark(&entry.path());
        }
    }
}

#[cfg(not(unix))]
fn mark_executables(_dir: &Path) {}

async fn install_github(app: &AppHandle, def: &ToolDef, target: &Target) -> Result<(), String> {
    if is_installing(def.id) {
        return Err("@t:compat.alreadyInstalling".to_string());
    }
    let _guard = InstallGuard(def.id.to_string());

    let mut cache = read_cache(app);
    let release = match cache.entries.get(def.id).cloned() {
        Some(release) => release,
        None => {
            let release = fetch_latest(def.repo)
                .await?
                .ok_or_else(|| "@t:compat.noRelease".to_string())?;
            cache.entries.insert(def.id.to_string(), release.clone());
            write_cache(app, &cache);
            release
        }
    };
    let asset = catalog::select_asset(def.id, &target.arch, &release.assets)
        .ok_or_else(|| "@t:compat.noAsset".to_string())?
        .clone();
    if asset.url.is_empty() {
        return Err("@t:compat.noAsset".to_string());
    }
    let tag = safe_tag(&release.tag);
    if scan_installed(app, target, def)
        .iter()
        .any(|entry| entry.tag == tag)
    {
        return Ok(());
    }

    let downloads = compat_root(app).join(".downloads");
    let temp_root = compat_root(app).join(".tmp");
    tokio::fs::create_dir_all(&downloads)
        .await
        .map_err(|error| error.to_string())?;
    tokio::fs::create_dir_all(&temp_root)
        .await
        .map_err(|error| error.to_string())?;
    let safe_asset = asset.name.replace(['/', '\\'], "_");
    let part = downloads.join(format!(
        "{}-{}-{}-{safe_asset}.part",
        def.id,
        target.key(),
        tag
    ));
    let temp = temp_root.join(format!("{}-{}-{}", def.id, tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&temp);

    download_asset(app, def.id, &asset, &part).await?;

    emit_progress(app, def.id, "extract", 100, asset.size, asset.size);
    let kind = catalog::archive_kind(&asset.name);
    let archive = part.clone();
    let extract_dir = temp.clone();
    let asset_name = safe_asset.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&extract_dir).map_err(|error| error.to_string())?;
        if kind == ArchiveKind::Plain {
            let target = extract_dir.join(asset_name);
            std::fs::copy(&archive, target).map_err(|error| error.to_string())?;
            Ok(())
        } else {
            extract_archive(&archive, kind, &extract_dir)
        }
    })
    .await
    .map_err(|error| error.to_string())??;

    let dest = tool_root(app, target, def.id).join(&tag);
    promote(&temp, &dest)?;
    mark_executables(&dest);
    let manifest = InstallManifest {
        id: def.id.to_string(),
        tag: tag.clone(),
        asset: asset.name.clone(),
        size: asset.size,
        digest: asset.digest.clone(),
        installed_at: now_secs(),
    };
    if let Ok(text) = serde_json::to_string_pretty(&manifest) {
        let _ = std::fs::write(dest.join("manifest.json"), text);
    }
    let _ = tokio::fs::remove_file(&part).await;
    let _ = std::fs::remove_dir_all(&temp);
    emit_progress(app, def.id, "done", 100, asset.size, asset.size);
    Ok(())
}

#[tauri::command]
pub async fn compat_catalog(
    app: AppHandle,
    target: Option<String>,
    refresh: Option<bool>,
) -> Result<CompatCatalog, String> {
    let target = Target::parse(target.as_deref())?;
    build_catalog(&app, &target, refresh.unwrap_or(false)).await
}

#[tauri::command]
pub async fn compat_install(
    app: AppHandle,
    id: String,
    target: Option<String>,
) -> Result<CompatToolInfo, String> {
    let target = Target::parse(target.as_deref())?;
    let def = catalog::find(&id).ok_or_else(|| "@t:compat.unknownTool".to_string())?;
    if !target.supports(def) {
        return Err("@t:compat.notForTarget".to_string());
    }
    match def.source {
        ToolSource::Module => {
            if !target.is_current() {
                return Err("@t:compat.moduleCurrentOnly".to_string());
            }
            if is_installing(def.id) {
                return Err("@t:compat.alreadyInstalling".to_string());
            }
            let _guard = InstallGuard(def.id.to_string());
            ensure_module(&app, def.id).await?;
        }
        ToolSource::Github => install_github(&app, def, &target).await?,
        ToolSource::External => return Err("@t:compat.externalOnly".to_string()),
    }
    let catalog = build_catalog(&app, &target, false).await?;
    catalog
        .tools
        .into_iter()
        .find(|tool| tool.id == id)
        .ok_or_else(|| "@t:compat.unknownTool".to_string())
}

#[tauri::command]
pub async fn compat_remove(
    app: AppHandle,
    id: String,
    target: Option<String>,
) -> Result<(), String> {
    let target = Target::parse(target.as_deref())?;
    let def = catalog::find(&id).ok_or_else(|| "@t:compat.unknownTool".to_string())?;
    if def.source != ToolSource::Github {
        return Err("@t:compat.notRemovable".to_string());
    }
    if is_installing(def.id) {
        return Err("@t:compat.alreadyInstalling".to_string());
    }
    let root = tool_root(&app, &target, def.id);
    if root.exists() {
        std::fs::remove_dir_all(&root).map_err(|error| error.to_string())?;
    }
    // A cancelled or interrupted download leaves a resumable part behind; a
    // removed tool should not keep a half-gigabyte file forever.
    let prefix = format!("{}-{}-", def.id, target.key());
    if let Ok(entries) = std::fs::read_dir(compat_root(&app).join(".downloads")) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn compat_cancel(id: String) {
    if is_installing(&id) {
        if let Ok(mut set) = cancelled().lock() {
            set.insert(id);
        }
    }
}

#[tauri::command]
pub fn compat_tools_dir(app: AppHandle) -> String {
    compat_root(&app).display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_digest_is_only_accepted_with_64_hex_characters() {
        assert_eq!(
            digest_hex(&Some(
                "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into()
            )),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string())
        );
        assert_eq!(digest_hex(&Some("sha256:xyz".into())), None);
        assert_eq!(digest_hex(&None), None);
    }

    #[test]
    fn a_part_hash_reads_the_whole_file() {
        let path = std::env::temp_dir().join(format!("efxlve_hash_{}", std::process::id()));
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(
            sha256_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_release_tag_stays_one_folder() {
        assert_eq!(safe_tag("v1.2.3"), "v1.2.3");
        assert_eq!(safe_tag("release/../x"), "release_.._x");
        assert_eq!(safe_tag(".."), "release");
        assert_eq!(safe_tag(""), "release");
    }

    #[test]
    fn archive_entries_cannot_escape_their_destination() {
        assert!(safe_entry_path(Path::new("GE-Proton/proton")));
        assert!(safe_entry_path(Path::new("dxvk/x64/d3d11.dll")));
        assert!(!safe_entry_path(Path::new("../escape.txt")));
        assert!(!safe_entry_path(Path::new("folder/../../escape.txt")));
        assert!(!safe_entry_path(Path::new("/etc/passwd")));
    }

    #[test]
    fn a_single_top_folder_is_promoted_to_the_install_root() {
        let root = std::env::temp_dir().join(format!("efxlve_promote_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let tmp = root.join("tmp");
        std::fs::create_dir_all(tmp.join("GE-Proton11-10")).unwrap();
        std::fs::write(tmp.join("GE-Proton11-10/proton"), b"#!/bin/sh").unwrap();
        let dest = root.join("dest");
        promote(&tmp, &dest).unwrap();
        assert!(dest.join("proton").is_file());
        assert!(!tmp.exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
