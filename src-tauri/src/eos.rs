//! Epic Online Services redistributable detection and install.
//!
//! Uninstalling the Epic Games Launcher removes the system-wide service under
//! `Program Files\Epic Games\Epic Online Services`. Games then fail even though
//! this launcher is still signed in. Presence is the same directory check the
//! overlay status card already uses.
//!
//! The installer is Epic's official redistributable, `EpicOnlineServicesInstaller.exe`,
//! shipped inside the C SDK zip. Epic's public page
//! `https://onlineservices.epicgames.com/sdk` names the current archive id.
//! `https://onlineservices.epicgames.com/api/cosmos/sdk/download?archive_id={id}&archive_type=sdk`
//! redirects to `eos-sdk-releases.on.epicgames.com`. Only that one zip entry is
//! fetched (range requests); the rest of the SDK is never downloaded.
//! Legendary's `eos-overlay install` is a different, signed-in catalog payload and
//! does not show Epic's setup window, so it is not used here.
//!
//! The installer process is started visibly. Helper probes (`reg`, `tasklist`)
//! still use CREATE_NO_WINDOW.

use std::io::Write;
use tokio::io::AsyncWriteExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

const SDK_PAGE: &str = "https://onlineservices.epicgames.com/sdk";
const USER_AGENT: &str = "EfxlveLauncher";
/// C SDK archive id published on the EOS page (1.19.2.1) if that page cannot be read.
const EOS_SDK_ARCHIVE_FALLBACK: u32 = 901;
const INSTALLER_ENTRY: &str = "SDK/Tools/EpicOnlineServicesInstaller.exe";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Refuse a corrupt central-directory hit that would fill the disk.
const MAX_INSTALLER_BYTES: u64 = 700 * 1024 * 1024;

static INSTALLING: AtomicBool = AtomicBool::new(false);

#[derive(Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EosOverlayStatus {
    pub installed: bool,
    pub path: String,
    pub version: String,
    pub overlay_supported: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EosInstallEvent {
    state: String,
    progress: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EosInstallOutcome {
    pub outcome: String,
}

struct CentralDirPos {
    offset: u64,
    size: u64,
}

struct ZipEntry {
    method: u16,
    compressed_size: u64,
    uncompressed_size: u64,
    local_header_offset: u64,
}

struct BusyGuard;

impl BusyGuard {
    fn try_acquire() -> Result<Self, String> {
        if INSTALLING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("@t:eos.busy".into());
        }
        Ok(Self)
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        INSTALLING.store(false, Ordering::SeqCst);
    }
}

fn fail(err: impl std::fmt::Display) -> String {
    eprintln!("eos install: {err}");
    "@t:eos.failed".into()
}

/// `Program Files*\Epic Games\Epic Online Services`.
pub fn eos_service_dir(program_files_root: &Path) -> PathBuf {
    program_files_root
        .join("Epic Games")
        .join("Epic Online Services")
}

/// First existing service directory among the given Program Files roots.
pub fn find_eos_service_install(roots: &[PathBuf]) -> Option<PathBuf> {
    for root in roots {
        let dir = eos_service_dir(root);
        if dir.is_dir() {
            return Some(dir);
        }
    }
    None
}

fn program_files_roots() -> Vec<PathBuf> {
    ["ProgramFiles(x86)", "ProgramFiles", "ProgramW6432"]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok())
        .map(PathBuf::from)
        .collect()
}

fn dword_is_one(token: &str) -> bool {
    if token == "1" {
        return true;
    }
    let hex = token
        .strip_prefix("0x")
        .or_else(|| token.strip_prefix("0X"));
    match hex {
        Some(h) => u32::from_str_radix(h, 16).ok() == Some(1),
        None => false,
    }
}

/// `reg query` text for the EOS service key. Version is the last token on the
/// Version line. Overlay support accepts both `1` and the `0x1` DWORD form.
pub fn parse_eos_registry(text: &str) -> (String, bool) {
    let mut version = String::new();
    let mut overlay_supported = false;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Version") {
            if let Some(val) = rest.split_whitespace().last() {
                if !val.is_empty() && val != "REG_SZ" && val != "REG_DWORD" {
                    version = val.to_string();
                }
            }
        } else if let Some(rest) = line.strip_prefix("OverlayInstallSupported") {
            if let Some(val) = rest.split_whitespace().last() {
                overlay_supported = dword_is_one(val);
            }
        }
    }
    (version, overlay_supported)
}

/// Archive id of the C SDK (`archive_type` = `sdk`) from the public EOS download page.
/// The page JSON is sometimes HTML-escaped (`\"archive_id\":901`).
pub fn parse_sdk_archive_id(html: &str) -> Option<u32> {
    let mut from = 0;
    while let Some(rel) = html[from..].find("archive_type") {
        let at = from + rel;
        let window_end = (at + 96).min(html.len());
        let window = &html[at..window_end];
        let is_c_sdk = window
            .split(|c: char| !c.is_ascii_alphanumeric())
            .any(|token| token == "sdk");
        if is_c_sdk {
            let after_end = (at + 160).min(html.len());
            let after = &html[at..after_end];
            if let Some(id_rel) = after.find("archive_id") {
                let rest = &after[id_rel + "archive_id".len()..];
                let digits: String = rest
                    .chars()
                    .skip_while(|c| !c.is_ascii_digit())
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                if let Ok(id) = digits.parse::<u32>() {
                    if id > 0 {
                        return Some(id);
                    }
                }
            }
        }
        from = at + "archive_type".len();
    }
    None
}

/// `bytes START-END/TOTAL` from a range response.
pub fn parse_content_range(value: &str) -> Option<(u64, u64, u64)> {
    let rest = value.trim().strip_prefix("bytes ")?;
    let (span, total) = rest.split_once('/')?;
    if total == "*" {
        return None;
    }
    let (start, end) = span.split_once('-')?;
    Some((start.parse().ok()?, end.parse().ok()?, total.parse().ok()?))
}

fn read_eocd(tail: &[u8]) -> Option<CentralDirPos> {
    if tail.len() < 22 {
        return None;
    }
    let mut i = tail.len() - 22;
    loop {
        if tail.len() >= i + 22 && tail[i..i + 4] == [0x50, 0x4b, 0x05, 0x06] {
            let comment_len = u16::from_le_bytes([tail[i + 20], tail[i + 21]]) as usize;
            let end = i
                .checked_add(22)
                .and_then(|n| n.checked_add(comment_len));
            if end == Some(tail.len()) {
                let size = u32::from_le_bytes(tail[i + 12..i + 16].try_into().ok()?) as u64;
                let offset = u32::from_le_bytes(tail[i + 16..i + 20].try_into().ok()?) as u64;
                if size != 0xFFFF_FFFF && offset != 0xFFFF_FFFF && size > 0 {
                    return Some(CentralDirPos { offset, size });
                }
            }
        }
        if i == 0 {
            break;
        }
        i -= 1;
    }
    None
}

fn find_zip_entry(cd: &[u8], want: &str) -> Option<ZipEntry> {
    let mut i = 0;
    while i + 46 <= cd.len() {
        if cd[i..i + 4] != [0x50, 0x4b, 0x01, 0x02] {
            return None;
        }
        let method = u16::from_le_bytes(cd[i + 10..i + 12].try_into().ok()?);
        let compressed = u32::from_le_bytes(cd[i + 20..i + 24].try_into().ok()?) as u64;
        let uncompressed = u32::from_le_bytes(cd[i + 24..i + 28].try_into().ok()?) as u64;
        let nlen = u16::from_le_bytes(cd[i + 28..i + 30].try_into().ok()?) as usize;
        let elen = u16::from_le_bytes(cd[i + 30..i + 32].try_into().ok()?) as usize;
        let clen = u16::from_le_bytes(cd[i + 32..i + 34].try_into().ok()?) as usize;
        let local_off = u32::from_le_bytes(cd[i + 42..i + 46].try_into().ok()?) as u64;
        let name_at = i + 46;
        let extra_at = name_at + nlen;
        let next = extra_at + elen + clen;
        if next > cd.len() {
            return None;
        }
        if compressed != 0xFFFF_FFFF && uncompressed != 0xFFFF_FFFF && local_off != 0xFFFF_FFFF {
            if let Ok(name) = std::str::from_utf8(&cd[name_at..name_at + nlen]) {
                let normalized = name.replace('\\', "/");
                if name == want || normalized == want {
                    return Some(ZipEntry {
                        method,
                        compressed_size: compressed,
                        uncompressed_size: uncompressed,
                        local_header_offset: local_off,
                    });
                }
            }
        }
        i = next;
    }
    None
}

pub fn local_header_data_offset(header: &[u8]) -> Option<u64> {
    if header.len() < 30 || header[0..4] != [0x50, 0x4b, 0x03, 0x04] {
        return None;
    }
    let nlen = u16::from_le_bytes([header[26], header[27]]) as u64;
    let elen = u16::from_le_bytes([header[28], header[29]]) as u64;
    Some(30 + nlen + elen)
}

fn hidden_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn eos_overlay_status_blocking() -> EosOverlayStatus {
    let found = find_eos_service_install(&program_files_roots());
    let installed = found.is_some();
    let path = found.map(|p| p.to_string_lossy().to_string()).unwrap_or_default();

    let mut version = String::new();
    let mut overlay_supported = false;
    #[cfg(windows)]
    {
        for key in [
            r"HKLM\SOFTWARE\WOW6432Node\Epic Games\EOS\MainService",
            r"HKLM\SOFTWARE\Epic Games\EOS\MainService",
        ] {
            let Ok(out) = hidden_command("reg").args(["query", key]).output() else {
                continue;
            };
            let text = String::from_utf8_lossy(&out.stdout);
            let (ver, overlay) = parse_eos_registry(&text);
            if overlay {
                overlay_supported = true;
            }
            if !ver.is_empty() {
                version = ver;
                break;
            }
        }
    }

    EosOverlayStatus {
        installed,
        path,
        version,
        overlay_supported,
    }
}

#[tauri::command]
pub async fn eos_overlay_status() -> EosOverlayStatus {
    tauri::async_runtime::spawn_blocking(eos_overlay_status_blocking)
        .await
        .unwrap_or_default()
}

fn emit(app: &AppHandle, state: &str, progress: u8) {
    let _ = app.emit(
        "eos-install",
        EosInstallEvent {
            state: state.to_string(),
            progress,
        },
    );
}

fn page_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(USER_AGENT)
        .build()
        .map_err(fail)
}

fn zip_client() -> Result<reqwest::Client, String> {
    // No total timeout: the installer entry is hundreds of megabytes.
    // A read timeout still ends a socket that stops delivering bytes, so the
    // settings row can return to the Download button instead of sitting still.
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .read_timeout(std::time::Duration::from_secs(45))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(USER_AGENT)
        .build()
        .map_err(fail)
}

fn cosmos_url(archive_id: u32) -> String {
    format!(
        "https://onlineservices.epicgames.com/api/cosmos/sdk/download?archive_id={archive_id}&archive_type=sdk"
    )
}

fn is_epic_download_host(url: &Url) -> bool {
    matches!(url.host_str(), Some(host) if host == "eos-sdk-releases.on.epicgames.com" || host.ends_with(".epicgames.com"))
}

async fn current_archive_id(client: &reqwest::Client) -> u32 {
    let Ok(resp) = client.get(SDK_PAGE).send().await else {
        return EOS_SDK_ARCHIVE_FALLBACK;
    };
    if !resp.status().is_success() {
        return EOS_SDK_ARCHIVE_FALLBACK;
    }
    if resp.content_length().unwrap_or(0) > 3_000_000 {
        return EOS_SDK_ARCHIVE_FALLBACK;
    }
    let Ok(text) = resp.text().await else {
        return EOS_SDK_ARCHIVE_FALLBACK;
    };
    parse_sdk_archive_id(&text).unwrap_or(EOS_SDK_ARCHIVE_FALLBACK)
}

async fn resolve_cdn_url(client: &reqwest::Client, archive_id: u32) -> Result<Url, String> {
    let resp = client
        .get(cosmos_url(archive_id))
        .send()
        .await
        .map_err(fail)?;
    if !resp.status().is_redirection() {
        return Err(fail(format!("cosmos status {}", resp.status())));
    }
    let loc = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| fail("missing redirect"))?
        .to_string();
    let next = resp.url().join(&loc).map_err(fail)?;
    if !is_epic_download_host(&next) || next.path().contains("/auth/login") {
        return Err(fail(format!("unexpected installer host {}", next.host_str().unwrap_or(""))));
    }
    Ok(next)
}

async fn ranged_get(
    client: &reqwest::Client,
    mut url: Url,
    range: &str,
) -> Result<reqwest::Response, String> {
    for _ in 0..4 {
        let resp = client
            .get(url.clone())
            .header(reqwest::header::RANGE, range)
            .send()
            .await
            .map_err(fail)?;
        if resp.status().is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| fail("range redirect missing"))?
                .to_string();
            url = resp.url().join(&loc).map_err(fail)?;
            if !is_epic_download_host(&url) {
                return Err(fail("redirect left Epic"));
            }
            continue;
        }
        return Ok(resp);
    }
    Err(fail("too many redirects"))
}

async fn read_bounded(resp: reqwest::Response, max: u64) -> Result<Vec<u8>, String> {
    let len = resp.content_length().unwrap_or(0);
    if len > max {
        return Err(fail("range response too large"));
    }
    let bytes = resp.bytes().await.map_err(fail)?;
    if bytes.len() as u64 > max {
        return Err(fail("range body too large"));
    }
    Ok(bytes.to_vec())
}

fn eos_cache_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("eos")
}

fn inflate_entry(method: u16, src: &Path, dest: &Path, expected: u64) -> Result<(), String> {
    let input = std::fs::File::open(src).map_err(fail)?;
    let mut output = std::fs::File::create(dest).map_err(fail)?;
    let written = match method {
        0 => std::io::copy(&mut std::io::BufReader::new(input), &mut output).map_err(fail)?,
        8 => {
            let mut decoder = flate2::read::DeflateDecoder::new(input);
            std::io::copy(&mut decoder, &mut output).map_err(fail)?
        }
        other => return Err(fail(format!("unsupported zip method {other}"))),
    };
    if written != expected {
        return Err(fail(format!("installer size {written} != {expected}")));
    }
    output.flush().map_err(fail)?;
    output.sync_all().map_err(fail)?;
    Ok(())
}

fn launch_installer(exe: &Path) -> std::io::Result<std::process::Child> {
    // No CREATE_NO_WINDOW: Epic's setup window has to be visible.
    let mut cmd = std::process::Command::new(exe);
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    cmd.spawn()
}

fn installer_image_running() -> bool {
    let Ok(out) = hidden_command("tasklist")
        .args([
            "/FI",
            "IMAGENAME eq EpicOnlineServicesInstaller.exe",
            "/FO",
            "CSV",
            "/NH",
        ])
        .output()
    else {
        return false;
    };
    String::from_utf8_lossy(&out.stdout)
        .to_ascii_lowercase()
        .contains("epiconlineservicesinstaller.exe")
}

fn wait_installer(mut child: std::process::Child) {
    let _ = child.wait();
    // The stub can exit after handing off to an elevated copy. Wait for that
    // image only while this install is still the active user action.
    #[cfg(windows)]
    {
        let mut saw = false;
        for _ in 0..20 {
            if installer_image_running() {
                saw = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        while saw && installer_image_running() {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    }
}

fn byte_percent(got: u64, total: u64) -> u8 {
    if total == 0 || got == 0 {
        return 0;
    }
    ((got.saturating_mul(100)) / total).min(99) as u8
}

async fn download_compressed(
    app: &AppHandle,
    client: &reqwest::Client,
    archive_id: u32,
    data_start: u64,
    compressed: u64,
    part: &Path,
) -> Result<(), String> {
    let mut got = tokio::fs::metadata(part)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if got > compressed {
        let _ = tokio::fs::remove_file(part).await;
        got = 0;
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(part)
        .await
        .map_err(fail)?;
    let mut failures = 0u8;
    let mut stalls = 0u8;
    let mut rounds = 0u8;
    let mut last_pct = byte_percent(got, compressed);
    emit(app, "downloading", last_pct);
    while got < compressed {
        rounds += 1;
        if rounds > 48 || failures >= 5 {
            return Err("@t:eos.failed".into());
        }
        let url = match resolve_cdn_url(client, archive_id).await {
            Ok(url) => url,
            Err(_) => {
                failures += 1;
                continue;
            }
        };
        let range = format!("bytes={}-{}", data_start + got, data_start + compressed - 1);
        let mut resp = match ranged_get(client, url, &range).await {
            Ok(resp) => resp,
            Err(_) => {
                failures += 1;
                continue;
            }
        };
        let status = resp.status();
        // A 200 is the whole object. Writing it would append the zip prefix
        // and then sit on a body that is not this entry.
        if status != reqwest::StatusCode::PARTIAL_CONTENT {
            failures += 1;
            continue;
        }
        let range_header = resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if let Some((start, _, _)) = parse_content_range(range_header) {
            if start != data_start + got {
                failures += 1;
                continue;
            }
        }
        let before = got;
        let mut failed = false;
        loop {
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    file.write_all(&chunk).await.map_err(fail)?;
                    got += chunk.len() as u64;
                    if got > compressed {
                        return Err(fail("download exceeded zip entry"));
                    }
                    let pct = byte_percent(got, compressed);
                    if pct != last_pct {
                        last_pct = pct;
                        emit(app, "downloading", pct);
                    }
                }
                Ok(None) => break,
                Err(err) => {
                    eprintln!("eos install: {err}");
                    failed = true;
                    break;
                }
            }
        }
        if failed {
            stalls += 1;
            if stalls >= 5 {
                return Err("@t:eos.failed".into());
            }
        } else {
            stalls = 0;
            if got > before {
                failures = 0;
            }
        }
        if got < compressed {
            failures += 1;
        }
    }
    file.flush().await.map_err(fail)?;
    file.sync_all().await.map_err(fail)?;
    Ok(())
}

fn remove_stale_installers(dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == keep {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if name.starts_with("EpicOnlineServicesInstaller") && name.ends_with(".exe") {
            let _ = std::fs::remove_file(path);
        }
    }
}

async fn ensure_installer(app: &AppHandle, archive_id: u32) -> Result<PathBuf, String> {
    let client = zip_client()?;
    emit(app, "downloading", 0);
    let url = resolve_cdn_url(&client, archive_id).await?;
    let tail_resp = ranged_get(&client, url, "bytes=-524288").await?;
    if tail_resp.status() != reqwest::StatusCode::PARTIAL_CONTENT
        && tail_resp.status() != reqwest::StatusCode::OK
    {
        return Err(fail(format!("zip tail status {}", tail_resp.status())));
    }
    let range_header = tail_resp
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let tail = read_bounded(tail_resp, 600_000).await?;
    let pos = read_eocd(&tail).ok_or_else(|| fail("zip directory missing"))?;
    let (cd_offset, cd_size) = (pos.offset, pos.size);
    if cd_size > 8 * 1024 * 1024 {
        return Err(fail("zip directory too large"));
    }
    let tail_start = parse_content_range(&range_header).map(|(start, _, _)| start);
    let cd_bytes = if let Some(start) = tail_start {
        if cd_offset >= start && cd_offset + cd_size <= start + tail.len() as u64 {
            let rel = (cd_offset - start) as usize;
            tail[rel..rel + cd_size as usize].to_vec()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };
    let cd_bytes = if cd_bytes.len() as u64 == cd_size {
        cd_bytes
    } else {
        let url = resolve_cdn_url(&client, archive_id).await?;
        let range = format!("bytes={}-{}", cd_offset, cd_offset + cd_size - 1);
        let resp = ranged_get(&client, url, &range).await?;
        read_bounded(resp, cd_size.saturating_add(1024)).await?
    };
    let entry = find_zip_entry(&cd_bytes, INSTALLER_ENTRY)
        .ok_or_else(|| fail("installer entry missing from EOS SDK zip"))?;
    if entry.compressed_size == 0
        || entry.uncompressed_size == 0
        || entry.compressed_size > MAX_INSTALLER_BYTES
        || entry.uncompressed_size > MAX_INSTALLER_BYTES
        || (entry.method != 0 && entry.method != 8)
    {
        return Err(fail("unexpected installer entry"));
    }

    let dir = eos_cache_dir(app);
    tokio::fs::create_dir_all(&dir).await.map_err(fail)?;
    let exe = dir.join(format!("EpicOnlineServicesInstaller-{archive_id}.exe"));
    if tokio::fs::metadata(&exe)
        .await
        .map(|m| m.len() == entry.uncompressed_size)
        .unwrap_or(false)
    {
        remove_stale_installers(&dir, &exe);
        emit(app, "downloading", 100);
        return Ok(exe);
    }

    let url = resolve_cdn_url(&client, archive_id).await?;
    let header_resp = ranged_get(
        &client,
        url,
        &format!(
            "bytes={}-{}",
            entry.local_header_offset,
            entry.local_header_offset + 29
        ),
    )
    .await?;
    let header = read_bounded(header_resp, 64).await?;
    let data_rel = local_header_data_offset(&header).ok_or_else(|| fail("bad local header"))?;
    let data_start = entry.local_header_offset + data_rel;
    let part = dir.join(format!("EpicOnlineServicesInstaller-{archive_id}.bin.part"));
    download_compressed(
        app,
        &client,
        archive_id,
        data_start,
        entry.compressed_size,
        &part,
    )
    .await?;

    let exe_part = dir.join(format!("EpicOnlineServicesInstaller-{archive_id}.exe.part"));
    let method = entry.method;
    let expected = entry.uncompressed_size;
    let part_for_task = part.clone();
    let exe_part_for_task = exe_part.clone();
    emit(app, "downloading", 100);
    let inflated = tauri::async_runtime::spawn_blocking(move || {
        inflate_entry(method, &part_for_task, &exe_part_for_task, expected)
    })
    .await
    .map_err(fail)?;
    if let Err(err) = inflated {
        let _ = tokio::fs::remove_file(&part).await;
        let _ = tokio::fs::remove_file(&exe_part).await;
        return Err(err);
    }
    let _ = tokio::fs::remove_file(&part).await;
    tokio::fs::rename(&exe_part, &exe).await.map_err(fail)?;
    remove_stale_installers(&dir, &exe);
    Ok(exe)
}

/// Downloads the official EOS redistributable and opens its setup window.
/// Nothing runs until the user clicks the notification or the Settings button.
#[tauri::command]
pub async fn eos_install_redistributable(app: AppHandle) -> Result<EosInstallOutcome, String> {
    let _busy = BusyGuard::try_acquire()?;
    if find_eos_service_install(&program_files_roots()).is_some() {
        return Ok(EosInstallOutcome {
            outcome: "installed".into(),
        });
    }

    let pages = page_client()?;
    let archive_id = current_archive_id(&pages).await;
    let exe = ensure_installer(&app, archive_id).await?;
    emit(&app, "launching", 100);
    let child = launch_installer(&exe).map_err(fail)?;
    let _ = tauri::async_runtime::spawn_blocking(move || wait_installer(child)).await;
    let installed = tauri::async_runtime::spawn_blocking(|| {
        find_eos_service_install(&program_files_roots()).is_some()
    })
    .await
    .unwrap_or(false);
    Ok(EosInstallOutcome {
        outcome: if installed {
            "installed"
        } else {
            "cancelled"
        }
        .into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_percent_stays_zero_until_a_full_percent() {
        assert_eq!(byte_percent(0, 300_000_000), 0);
        assert_eq!(byte_percent(1_000_000, 300_000_000), 0);
        assert_eq!(byte_percent(3_000_000, 300_000_000), 1);
        assert_eq!(byte_percent(299_000_000, 300_000_000), 99);
    }

    fn push_u16(buf: &mut Vec<u8>, value: u16) {
        buf.extend_from_slice(&value.to_le_bytes());
    }

    fn push_u32(buf: &mut Vec<u8>, value: u32) {
        buf.extend_from_slice(&value.to_le_bytes());
    }

    fn mini_zip(name: &str, payload: &[u8]) -> Vec<u8> {
        let name_b = name.as_bytes();
        let mut local = Vec::new();
        push_u32(&mut local, 0x0403_4b50);
        push_u16(&mut local, 20);
        push_u16(&mut local, 0);
        push_u16(&mut local, 0);
        push_u16(&mut local, 0);
        push_u16(&mut local, 0);
        push_u32(&mut local, 0);
        push_u32(&mut local, payload.len() as u32);
        push_u32(&mut local, payload.len() as u32);
        push_u16(&mut local, name_b.len() as u16);
        push_u16(&mut local, 0);
        local.extend_from_slice(name_b);
        local.extend_from_slice(payload);

        let mut cd = Vec::new();
        push_u32(&mut cd, 0x0201_4b50);
        push_u16(&mut cd, 20);
        push_u16(&mut cd, 20);
        push_u16(&mut cd, 0);
        push_u16(&mut cd, 0);
        push_u16(&mut cd, 0);
        push_u16(&mut cd, 0);
        push_u32(&mut cd, 0);
        push_u32(&mut cd, payload.len() as u32);
        push_u32(&mut cd, payload.len() as u32);
        push_u16(&mut cd, name_b.len() as u16);
        push_u16(&mut cd, 0);
        push_u16(&mut cd, 0);
        push_u16(&mut cd, 0);
        push_u16(&mut cd, 0);
        push_u32(&mut cd, 0);
        push_u32(&mut cd, 0);
        cd.extend_from_slice(name_b);

        let mut out = local;
        let cd_off = out.len() as u32;
        let cd_size = cd.len() as u32;
        out.extend_from_slice(&cd);
        push_u32(&mut out, 0x0605_4b50);
        push_u16(&mut out, 0);
        push_u16(&mut out, 0);
        push_u16(&mut out, 1);
        push_u16(&mut out, 1);
        push_u32(&mut out, cd_size);
        push_u32(&mut out, cd_off);
        push_u16(&mut out, 0);
        out
    }

    #[test]
    fn service_dir_uses_the_epic_online_services_folder() {
        let dir = eos_service_dir(Path::new("pf"));
        let mut comps = dir.components();
        let last = comps.next_back().unwrap().as_os_str();
        let prev = comps.next_back().unwrap().as_os_str();
        assert_eq!(prev, "Epic Games");
        assert_eq!(last, "Epic Online Services");
    }

    #[test]
    fn detects_install_only_when_the_service_directory_exists() {
        let root = std::env::temp_dir().join(format!("efxlve-eos-detect-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        assert!(find_eos_service_install(&[root.clone()]).is_none());
        let dir = eos_service_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();
        let found = find_eos_service_install(&[root.clone()]).unwrap();
        assert_eq!(found, dir);
        std::fs::remove_dir_all(&root).unwrap();
        assert!(find_eos_service_install(&[root]).is_none());
    }

    #[test]
    fn registry_parser_reads_version_and_dword_overlay_flag() {
        let text = "\
    Version    REG_SZ    1.19.2.1\r\n\
    OverlayInstallSupported    REG_DWORD    0x1\r\n";
        let (version, overlay) = parse_eos_registry(text);
        assert_eq!(version, "1.19.2.1");
        assert!(overlay);
        let (_version, off) = parse_eos_registry("    OverlayInstallSupported    REG_DWORD    0x0\r\n");
        assert!(!off);
    }

    #[test]
    fn page_parser_prefers_the_c_sdk_archive_id() {
        let escaped = r#"{\"archive_type\":\"sdk\",\"archive_id\":901,\"version\":\"1.19.2.1\"},{\"archive_type\":\"android\",\"archive_id\":902}"#;
        assert_eq!(parse_sdk_archive_id(escaped), Some(901));
        let plain = r#""archive_type":"sdk","archive_id":870,"#;
        assert_eq!(parse_sdk_archive_id(plain), Some(870));
        assert_eq!(parse_sdk_archive_id("no archive here"), None);
    }

    #[test]
    fn content_range_parses_zip_tail_bounds() {
        assert_eq!(
            parse_content_range("bytes 100-109/1000"),
            Some((100, 109, 1000))
        );
        assert_eq!(parse_content_range("bytes */1000"), None);
    }

    #[test]
    fn zip_index_finds_the_installer_payload() {
        let payload = b"hello-eos";
        let bytes = mini_zip(INSTALLER_ENTRY, payload);
        let pos = read_eocd(&bytes).unwrap();
        let cd = &bytes[pos.offset as usize..pos.offset as usize + pos.size as usize];
        let entry = find_zip_entry(cd, INSTALLER_ENTRY).unwrap();
        assert_eq!(entry.method, 0);
        assert_eq!(entry.uncompressed_size, payload.len() as u64);
        let off = entry.local_header_offset as usize;
        let data_off = local_header_data_offset(&bytes[off..off + 30]).unwrap() as usize;
        assert_eq!(&bytes[off + data_off..off + data_off + payload.len()], payload);
    }
}
