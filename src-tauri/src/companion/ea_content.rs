//! EA's content service: builds, download URLs and the ZIP package.
//!
//! The EA app downloads a game as one remote ZIP. The central directory at the
//! end of the archive lists every file with its CRC, sizes and local header
//! offset; the client reads that directory with HTTP range requests and then
//! fetches one entry at a time. This module is the first slice of that path:
//! resolve a build, resolve its download URL, read the ZIP manifest and pull a
//! single entry with CRC verification. It does not install a game yet.
//!
//! The protocol shapes follow Maxima (GPL-3.0); no Maxima binary is used.

// The install command and progress UI land after the content path; the probes
// in the tests exercise these functions today.
#![allow(dead_code)]

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll};

use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// One install can be cancelled from the UI; the flag is shared with the
/// download loop and the touchup step.
static JOBS: Mutex<Option<HashMap<String, Arc<AtomicBool>>>> = Mutex::new(None);

pub(crate) fn begin_job(offer_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    let mut jobs = JOBS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    jobs.get_or_insert_with(HashMap::new)
        .insert(offer_id.to_string(), flag.clone());
    flag
}

pub(crate) fn cancel_job(offer_id: &str) {
    if let Some(jobs) = JOBS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
    {
        if let Some(flag) = jobs.get(offer_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

pub(crate) fn end_job(offer_id: &str) {
    if let Some(jobs) = JOBS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_mut()
    {
        jobs.remove(offer_id);
    }
}

/// What the launcher last wrote for one offer. It records the build id for
/// titles whose package carries no version string.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallRecord {
    pub build_id: String,
    pub version: String,
    #[serde(default)]
    pub root: String,
    pub files: usize,
    pub bytes: u64,
}

fn records_path() -> PathBuf {
    super::accounts::data_dir().join("companion_ea_content.json")
}

fn records() -> HashMap<String, InstallRecord> {
    std::fs::read_to_string(records_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub(crate) fn recorded_install(offer_id: &str) -> Option<InstallRecord> {
    records().remove(offer_id)
}

pub(crate) fn record_install(offer_id: &str, record: InstallRecord) {
    let mut all = records();
    all.insert(offer_id.to_string(), record);
    save_records(&all);
}

pub(crate) fn forget_install(offer_id: &str) {
    let mut all = records();
    if all.remove(offer_id).is_some() {
        save_records(&all);
    }
}

fn save_records(all: &HashMap<String, InstallRecord>) {
    let path = records_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(all) {
        let _ = std::fs::write(path, text);
    }
}

const GRAPHQL: &str = "https://service-aggregation-layer.juno.ea.com/graphql";

const AVAILABLE_BUILDS: &str = r#"query availableBuilds($offerId: String!) {
    availableBuilds(offerId: $offerId) {
        buildId
        downloadType
        gameVersion
        buildLiveDate
        __typename
    }
}
"#;

const DOWNLOAD_URL: &str = r#"query downloadUrl($offerId: String!, $buildId: String) {
    downloadUrl(offerId: $offerId, buildId: $buildId) {
        url
        syncUrl
        __typename
    }
}
"#;

const EOCD_SIG: u32 = 0x0605_4b50;
const ZIP64_EOCD_SIG: u32 = 0x0606_4b50;
const ZIP64_LOCATOR_SIG: u32 = 0x0706_4b50;
const CENTRAL_SIG: u32 = 0x0201_4b50;
const LOCAL_SIG: u32 = 0x0403_4b50;
const MAX_BACKSCAN: u64 = 6 * 1024 * 1024;
/// The package's own installer manifest.
pub(crate) const INSTALLER_MANIFEST: &str = "__Installer/installerdata.xml";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EaBuild {
    pub build_id: String,
    pub download_type: String,
    pub game_version: String,
    pub live_date: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ZipEntry {
    pub name: String,
    pub compression: u16,
    pub crc32: u32,
    pub compressed: u64,
    pub uncompressed: u64,
    pub local_offset: u64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ZipManifest {
    pub entries: Vec<ZipEntry>,
    pub archive_size: u64,
    pub central_size: u64,
    pub central_offset: u64,
}

/// Everything a full install needs: the signed package, the target folder and
/// the entry list read from the ZIP central directory. The package's own
/// installer manifest is kept because it decides the touchup mode and whether
/// the title needs EA anti-cheat.
#[derive(Debug, Clone)]
pub(crate) struct InstallPlan {
    pub offer_id: String,
    pub build_id: String,
    pub version: String,
    pub download_url: String,
    /// The content service's sync endpoint for this build, when it offers one.
    /// It is the differential path; the full ZIP is the fallback.
    pub sync_url: Option<String>,
    pub root: PathBuf,
    pub manifest: ZipManifest,
    pub installer_xml: Option<String>,
    pub eaac: bool,
    /// The package carries the OOA activation runtime; the game hands the
    /// launch to the EA App even when the launcher installs the files.
    pub ooa: bool,
    /// A pre-DiP/disc installer (`<game>` root or `__Installer/DISK1`), not the
    /// content-service DiP layout. It must go through the EA App.
    pub legacy: bool,
    /// The legacy package carries the `<executable>` installer block, so the
    /// content service can run its touchup without the EA App.
    pub legacy_installable: bool,
}

impl InstallPlan {
    pub(crate) fn total_compressed(&self) -> u64 {
        self.manifest.total_compressed()
    }

    pub(crate) fn total_uncompressed(&self) -> u64 {
        self.manifest.total_uncompressed()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DownloadReport {
    pub files: usize,
    pub bytes: u64,
    pub skipped: usize,
    pub skipped_bytes: u64,
}

/// One progress tick after a file lands or is skipped.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DownloadProgress {
    pub files: usize,
    pub bytes: u64,
    pub skipped: usize,
    pub skipped_bytes: u64,
    /// Downloaded plus reused bytes, the numerator of the install percentage.
    pub done_bytes: u64,
    pub total_files: usize,
    pub total_bytes: u64,
}

impl ZipManifest {
    pub(crate) fn total_compressed(&self) -> u64 {
        self.entries.iter().map(|entry| entry.compressed).sum()
    }

    pub(crate) fn total_uncompressed(&self) -> u64 {
        self.entries.iter().map(|entry| entry.uncompressed).sum()
    }

    pub(crate) fn smallest(&self) -> Option<&ZipEntry> {
        self.entries
            .iter()
            .filter(|entry| entry.uncompressed > 0 && entry.compressed > 0)
            .min_by_key(|entry| entry.compressed)
    }
}

/// The CDN rejects requests without an EA user agent; use the same one the
/// login and license calls send.
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("EAApp/PC/13.680.0.6193")
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Builds the EA account can install for one offer, newest first as the
/// service returns them.
pub(crate) async fn available_builds(access: &str, offer_id: &str) -> Result<Vec<EaBuild>, String> {
    let value = graphql(
        access,
        AVAILABLE_BUILDS,
        "availableBuilds",
        json!({ "offerId": offer_id }),
    )
    .await?;
    let items = value
        .pointer("/data/availableBuilds")
        .and_then(Value::as_array)
        .ok_or_else(|| "EA content: availableBuilds missing".to_string())?;

    let mut builds = Vec::with_capacity(items.len());
    for item in items {
        builds.push(EaBuild {
            build_id: text(item, "buildId"),
            download_type: text(item, "downloadType"),
            game_version: text(item, "gameVersion"),
            live_date: text(item, "buildLiveDate"),
        });
    }
    Ok(builds)
}

/// The signed URL of the ZIP package for one build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DownloadLinks {
    pub url: String,
    /// The content service's sync endpoint, when the build publishes one.
    pub sync_url: Option<String>,
}

/// Both URLs the download query carries. The sync URL is optional; `url` is
/// always the full package and remains the fallback.
pub(crate) async fn download_links(
    access: &str,
    offer_id: &str,
    build_id: &str,
) -> Result<DownloadLinks, String> {
    let value = graphql(
        access,
        DOWNLOAD_URL,
        "downloadUrl",
        json!({ "offerId": offer_id, "buildId": build_id }),
    )
    .await?;
    parse_download_links(&value)
}

fn parse_download_links(value: &Value) -> Result<DownloadLinks, String> {
    let url = value
        .pointer("/data/downloadUrl/url")
        .and_then(Value::as_str)
        .filter(|url| url.starts_with("https://"))
        .map(str::to_string)
        .ok_or_else(|| "EA content: downloadUrl missing".to_string())?;
    let sync_url = value
        .pointer("/data/downloadUrl/syncUrl")
        .and_then(Value::as_str)
        .filter(|url| url.starts_with("https://"))
        .map(str::to_string);
    Ok(DownloadLinks { url, sync_url })
}

pub(crate) async fn download_url(
    access: &str,
    offer_id: &str,
    build_id: &str,
) -> Result<String, String> {
    Ok(download_links(access, offer_id, build_id).await?.url)
}

/// Free bytes on the volume that holds `path`, when the platform reports them.
pub(crate) fn available_space(path: &Path) -> Option<u64> {
    let mut probe = path.to_path_buf();
    while !probe.exists() {
        probe = probe.parent()?.to_path_buf();
    }
    let probe = probe.canonicalize().unwrap_or(probe);
    let probe = probe.to_string_lossy().to_lowercase();
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let mut best: Option<(usize, u64)> = None;
    for disk in disks.list() {
        let mount = disk.mount_point().to_string_lossy().to_lowercase();
        if probe.starts_with(&mount) {
            let length = mount.len();
            if best.map(|(current, _)| length > current).unwrap_or(true) {
                best = Some((length, disk.available_space()));
            }
        }
    }
    best.map(|(_, free)| free)
}

/// A readable size for the localized disk-space error.
pub(crate) fn human_bytes(bytes: u64) -> String {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    if bytes as f64 >= GB {
        format!("{:.1} GB", bytes as f64 / GB)
    } else {
        format!("{:.0} MB", bytes as f64 / MB)
    }
}

/// Refuses a download that cannot fit, with room for temporary `.part` files.
pub(crate) fn ensure_disk_space(plan: &InstallPlan) -> Result<(), String> {
    const MARGIN: u64 = 512 * 1024 * 1024;
    let needed = plan.total_uncompressed().saturating_add(MARGIN);
    let Some(free) = available_space(&plan.root) else {
        return Ok(());
    };
    if free < needed {
        return Err(format!(
            "@t:ea.notEnoughSpace\u{1f}{}\u{1f}{}\u{1f}{}",
            human_bytes(needed),
            human_bytes(free),
            plan.root.display()
        ));
    }
    Ok(())
}

/// An expired or forbidden signed URL can be replaced by a fresh plan.
pub(crate) fn auth_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    ["401", "403", "410", "forbidden", "unauthorized", "expired"]
        .iter()
        .any(|needle| error.contains(needle))
}

/// Resolves the live build and its package for one offer.
pub(crate) async fn plan_install(    access: &str,
    offer_id: &str,
    root: &Path,
) -> Result<InstallPlan, String> {
    let builds = available_builds(access, offer_id).await?;
    let build = builds
        .iter()
        .find(|build| build.download_type.eq_ignore_ascii_case("live"))
        .or_else(|| builds.first())
        .ok_or_else(|| "EA content: no build for this offer".to_string())?;
    let links = download_links(access, offer_id, &build.build_id).await?;
    let url = links.url;
    let sync_url = links.sync_url;
    let manifest = read_manifest(&url).await?;
    let installer_xml = match manifest
        .entries
        .iter()
        .find(|entry| entry.name.eq_ignore_ascii_case(INSTALLER_MANIFEST))
    {
        Some(entry) => {
            let bytes = read_entry(&url, entry).await?;
            super::ea_direct::decode(&bytes)
                .or_else(|| Some(String::from_utf8_lossy(&bytes).into_owned()))
        }
        None => None,
    };
    let eaac = installer_xml
        .as_deref()
        .map(manifest_needs_eaac)
        .unwrap_or(false);
    // A package without a DiP manifest is a legacy/disc installer. The content
    // service can list it, but its touchup/registry layout is not ours to use.
    let legacy = installer_xml
        .as_deref()
        .map(|xml| !is_dip_manifest(xml))
        .unwrap_or(true);
    let legacy_installable = installer_xml
        .as_deref()
        .map(|xml| !is_dip_manifest(xml) && legacy_executable(xml))
        .unwrap_or(false);
    let ooa = manifest
        .entries
        .iter()
        .any(|entry| entry_needs_ooa(&entry.name));
    Ok(InstallPlan {
        offer_id: offer_id.to_string(),
        build_id: build.build_id.clone(),
        version: build.game_version.clone(),
        download_url: url,
        sync_url,
        root: root.to_path_buf(),
        manifest,
        installer_xml,
        eaac,
        ooa,
        legacy,
        legacy_installable,
    })
}

/// The sync package's full replacement files.
///
/// The sync ZIP also carries `.eaPatchDiff` deltas and the patch metadata. The
/// metadata in the live package is a template placeholder, so the launcher uses
/// the full files the sync ZIP pairs with each delta; the full-package pass
/// fills in anything the sync set does not name.
pub(crate) fn sync_file_entries(manifest: &ZipManifest) -> Vec<ZipEntry> {
    manifest
        .entries
        .iter()
        .filter(|entry| {
            let name = entry.name.replace('\\', "/");
            let lower = name.to_ascii_lowercase();
            if entry.uncompressed == 0 || name.ends_with('/') {
                return false;
            }
            !lower.ends_with(".eapatchdiff")
                && !lower.ends_with("eapatchinfo")
                && !lower.ends_with("eapatchimpl")
        })
        .cloned()
        .collect()
}

/// True for the pre-DiP `<executable>` installer block.
pub(crate) fn legacy_executable(xml: &str) -> bool {
    xml.to_ascii_lowercase().contains("<executable")
}

/// True for the DiP installer manifest (the content-service layout).
pub(crate) fn is_dip_manifest(xml: &str) -> bool {
    xml.to_ascii_lowercase().contains("<dipmanifest")
}

/// EA anti-cheat titles carry Javelin's launcher in their installer manifest.
pub(crate) fn manifest_needs_eaac(xml: &str) -> bool {
    let lower = xml.to_ascii_lowercase();
    lower.contains("eaanticheat") || lower.contains("ea anti-cheat")
}

/// The package ships the OOA activation runtime next to the game executable.
pub(crate) fn entry_needs_ooa(name: &str) -> bool {
    let name = format!("/{}", name.replace('\\', "/").to_ascii_lowercase());
    [
        "/core/activation.exe",
        "/core/activation.dll",
        "/core/activation64.dll",
        "/core/activationui.exe",
    ]
    .iter()
    .any(|suffix| name.ends_with(suffix))
}

/// Reads the ZIP central directory with range requests.
pub(crate) async fn read_manifest(url: &str) -> Result<ZipManifest, String> {
    let client = client();
    let size = remote_size(&client, url).await?;
    if size < 22 {
        return Err("EA content: package is too small".into());
    }

    let tail_len = size.min(MAX_BACKSCAN);
    let tail_start = size - tail_len;
    let tail = range_get(&client, url, tail_start, size - 1).await?;
    let eocd = read_eocd(&tail, tail_start, size)?;

    let central = range_get(
        &client,
        url,
        eocd.central_offset,
        eocd.central_offset + eocd.central_size - 1,
    )
    .await?;
    let entries = parse_central_directory(&central)?;

    Ok(ZipManifest {
        entries,
        archive_size: size,
        central_size: eocd.central_size,
        central_offset: eocd.central_offset,
    })
}

/// Downloads one entry, decompresses it and verifies its size and CRC.
pub(crate) async fn download_entry(
    url: &str,
    entry: &ZipEntry,
    destination: &Path,
) -> Result<u64, String> {
    let client = client();
    write_entry(&client, url, entry, destination, None)
        .await
        .map(|(bytes, _)| bytes)
}

async fn write_entry(
    client: &reqwest::Client,
    url: &str,
    entry: &ZipEntry,
    destination: &Path,
    cancelled: Option<&AtomicBool>,
) -> Result<(u64, bool), String> {
    let mut attempt = 0u32;
    loop {
        match write_entry_once(client, url, entry, destination, cancelled).await {
            Ok(result) => return Ok(result),
            Err(error) if attempt < 3 && transient_error(&error) => {
                if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                    return Err("EA content: cancelled".into());
                }
                attempt += 1;
                tokio::time::sleep(std::time::Duration::from_millis(400 * u64::from(attempt)))
                    .await;
            }
            Err(error) => return Err(error),
        }
    }
}

/// A network failure worth another range request. CRC and size mismatches are
/// not retried by this check; the next install verifies them again.
pub(crate) fn transient_error(error: &str) -> bool {
    [
        "error sending request",
        "error decoding response body",
        "connection reset",
        "connection closed",
        "timed out",
        "temporarily unavailable",
        "429",
        "500",
        "502",
        "503",
        "504",
    ]
    .iter()
    .any(|needle| error.contains(needle))
}

async fn write_entry_once(
    client: &reqwest::Client,
    url: &str,
    entry: &ZipEntry,
    destination: &Path,
    cancelled: Option<&AtomicBool>,
) -> Result<(u64, bool), String> {
    if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        return Err("EA content: cancelled".into());
    }
    if entry.compressed == 0 {
        if let Ok(meta) = tokio::fs::metadata(destination).await {
            if meta.len() == 0 {
                return Ok((0, true));
            }
        }
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|err| format!("EA content: {err}"))?;
        }
        tokio::fs::write(destination, [])
            .await
            .map_err(|err| format!("EA content: {err}"))?;
        return Ok((0, false));
    }

    // A previous run may already have this file; size plus CRC is the same
    // check the downloader uses, so a resumed install skips it without traffic.
    if let Ok(meta) = tokio::fs::metadata(destination).await {
        if meta.len() == entry.uncompressed {
            if let Ok(crc) = file_crc(destination).await {
                if crc == entry.crc32 {
                    return Ok((entry.uncompressed, true));
                }
            }
        }
    }

    // The local header carries the name/extra lengths the central directory
    // does not repeat; the data range starts after them.
    let header = range_get(client, url, entry.local_offset, entry.local_offset + 29).await?;
    if u32_at(&header, 0) != Some(LOCAL_SIG) {
        return Err("EA content: bad local header".into());
    }
    let name_len = u16_at(&header, 26).ok_or("EA content: short local header")? as u64;
    let extra_len = u16_at(&header, 28).ok_or("EA content: short local header")? as u64;
    let data_start = entry.local_offset + 30 + name_len + extra_len;
    let data_end = data_start + entry.compressed - 1;

    let response = client
        .get(url)
        .header("Range", format!("bytes={data_start}-{data_end}"))
        .send()
        .await
        .map_err(|err| format!("EA content: {err}"))?;
    if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(format!(
            "EA content: server did not honour the range (HTTP {})",
            response.status()
        ));
    }

    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|err| format!("EA content: {err}"))?;
    }
    let part = destination.with_file_name(format!(
        "{}.part",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("entry")
    ));
    let file = tokio::fs::File::create(&part)
        .await
        .map_err(|err| format!("EA content: {err}"))?;
    let file = tokio::io::BufWriter::with_capacity(1024 * 1024, file);

    let (crc, bytes) = match entry.compression {
        0 => {
            let mut writer = CrcWriter::new(file);
            stream_into(&mut writer, response, cancelled).await?;
            writer
                .shutdown()
                .await
                .map_err(|err| format!("EA content: {err}"))?;
            (writer.crc(), writer.bytes())
        }
        8 => {
            let writer = CrcWriter::new(file);
            let mut decoder = async_compression::tokio::write::DeflateDecoder::new(writer);
            stream_into(&mut decoder, response, cancelled).await?;
            decoder
                .shutdown()
                .await
                .map_err(|err| format!("EA content: {err}"))?;
            let writer = decoder.get_ref();
            (writer.crc(), writer.bytes())
        }
        other => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(format!("EA content: unsupported compression {other}"));
        }
    };

    if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("EA content: cancelled".into());
    }

    if bytes != entry.uncompressed {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!(
            "EA content: entry size {} != {}",
            bytes, entry.uncompressed
        ));
    }
    if crc != entry.crc32 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("EA content: CRC mismatch".into());
    }

    let _ = tokio::fs::remove_file(destination).await;
    tokio::fs::rename(&part, destination)
        .await
        .map_err(|err| format!("EA content: {err}"))?;
    Ok((bytes, false))
}

async fn file_crc(path: &Path) -> Result<u32, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|err| format!("EA content: {err}"))?;
    let mut hasher = crc32fast::Hasher::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|err| format!("EA content: {err}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize())
}

async fn stream_into<W: AsyncWrite + Unpin>(
    writer: &mut W,
    mut response: reqwest::Response,
    cancelled: Option<&AtomicBool>,
) -> Result<(), String> {
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("EA content: {err}"))?
    {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            return Err("EA content: cancelled".into());
        }
        crate::download_limit::throttle(chunk.len()).await;
        writer
            .write_all(&chunk)
            .await
            .map_err(|err| format!("EA content: {err}"))?;
    }
    Ok(())
}

/// Forwards decompressed bytes to the file while counting them and their CRC.
struct CrcWriter<W> {
    inner: W,
    hasher: crc32fast::Hasher,
    bytes: u64,
}

impl<W> CrcWriter<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            hasher: crc32fast::Hasher::new(),
            bytes: 0,
        }
    }

    fn crc(&self) -> u32 {
        self.hasher.clone().finalize()
    }

    fn bytes(&self) -> u64 {
        self.bytes
    }
}

impl<W: AsyncWrite + Unpin> AsyncWrite for CrcWriter<W> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_write(cx, buf) {
            Poll::Ready(Ok(written)) => {
                this.hasher.update(&buf[..written]);
                this.bytes += written as u64;
                Poll::Ready(Ok(written))
            }
            other => other,
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Reads one entry into memory, for `installerdata.xml` and other small files.
pub(crate) async fn read_entry(url: &str, entry: &ZipEntry) -> Result<Vec<u8>, String> {
    let client = client();
    fetch_entry(&client, url, entry).await
}

async fn fetch_entry(
    client: &reqwest::Client,
    url: &str,
    entry: &ZipEntry,
) -> Result<Vec<u8>, String> {
    if entry.compressed > 256 * 1024 * 1024 {
        return Err("EA content: refusing an entry larger than 256 MB in the probe".into());
    }

    // The local header carries the name/extra lengths the central directory
    // does not repeat; read it first so the data range is exact.
    let header = range_get(client, url, entry.local_offset, entry.local_offset + 29).await?;
    if u32_at(&header, 0) != Some(LOCAL_SIG) {
        return Err("EA content: bad local header".into());
    }
    let name_len = u16_at(&header, 26).ok_or("EA content: short local header")? as u64;
    let extra_len = u16_at(&header, 28).ok_or("EA content: short local header")? as u64;
    let data_start = entry.local_offset + 30 + name_len + extra_len;
    let data_end = data_start + entry.compressed - 1;
    let packet = range_get(client, url, data_start, data_end).await?;
    if packet.len() as u64 != entry.compressed {
        return Err(format!(
            "EA content: range returned {} bytes, expected {}",
            packet.len(),
            entry.compressed
        ));
    }

    let data = match entry.compression {
        0 => packet,
        8 => {
            let mut out = Vec::with_capacity(entry.uncompressed as usize);
            flate2::read::DeflateDecoder::new(packet.as_slice())
                .read_to_end(&mut out)
                .map_err(|err| format!("EA content: inflate: {err}"))?;
            out
        }
        other => return Err(format!("EA content: unsupported compression {other}")),
    };

    if data.len() as u64 != entry.uncompressed {
        return Err(format!(
            "EA content: entry size {} != {}",
            data.len(),
            entry.uncompressed
        ));
    }
    if crc32fast::hash(&data) != entry.crc32 {
        return Err("EA content: CRC mismatch".into());
    }
    Ok(data)
}

/// Downloads a set of entries with four range workers.
pub(crate) async fn download_entries(
    url: &str,
    root: &Path,
    entries: &[ZipEntry],
) -> Result<DownloadReport, String> {
    download_entries_with_progress(url, root, entries, |_| {}).await
}

/// The same loop, reporting after every file so an install can show progress.
pub(crate) async fn download_entries_with_progress(
    url: &str,
    root: &Path,
    entries: &[ZipEntry],
    on_progress: impl FnMut(DownloadProgress) + Send,
) -> Result<DownloadReport, String> {
    download_entries_controlled(url, root, entries, None, on_progress).await
}

/// The install loop, with an optional cancel flag checked while files stream.
pub(crate) async fn download_entries_controlled(
    url: &str,
    root: &Path,
    entries: &[ZipEntry],
    cancelled: Option<Arc<AtomicBool>>,
    mut on_progress: impl FnMut(DownloadProgress) + Send,
) -> Result<DownloadReport, String> {
    let client = client();
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(16));
    let mut set = tokio::task::JoinSet::new();
    let mut skipped = 0usize;
    let total_files = entries
        .iter()
        .filter(|entry| !entry.name.is_empty() && !entry.name.ends_with('/'))
        .count();
    let total_bytes: u64 = entries
        .iter()
        .filter(|entry| !entry.name.is_empty() && !entry.name.ends_with('/'))
        .map(|entry| entry.uncompressed)
        .sum();

    for entry in entries {
        if entry.name.is_empty() || entry.name.ends_with('/') {
            skipped += 1;
            continue;
        }
        let permit = semaphore.clone();
        let client = client.clone();
        let url = url.to_string();
        let root = root.to_path_buf();
        let entry = entry.clone();
        let cancelled = cancelled.clone();
        // The semaphore lives in the task, so the loop can queue every entry
        // and report completions while only four transfers are in flight.
        set.spawn(async move {
            let _permit = permit
                .acquire_owned()
                .await
                .map_err(|err| format!("EA content: {err}"))?;
            if cancelled
                .as_deref()
                .is_some_and(|flag| flag.load(Ordering::Relaxed))
            {
                return Err("EA content: cancelled".into());
            }
            let destination = probe_path(&root, &entry.name)?;
            write_entry(&client, &url, &entry, &destination, cancelled.as_deref()).await
        });
    }

    let mut report = DownloadReport {
        skipped,
        ..DownloadReport::default()
    };
    // Publish the totals before the first file lands, so a large entry does not
    // leave the UI on a blank progress bar.
    on_progress(DownloadProgress {
        total_files,
        total_bytes,
        ..DownloadProgress::default()
    });
    while let Some(result) = set.join_next().await {
        match result {
            Ok(Ok((bytes, reused))) => {
                if reused {
                    report.skipped += 1;
                    report.skipped_bytes += bytes;
                } else {
                    report.files += 1;
                    report.bytes += bytes;
                }
            }
            Ok(Err(err)) => {
                set.abort_all();
                if cancelled
                    .as_deref()
                    .is_some_and(|flag| flag.load(Ordering::Relaxed))
                {
                    return Err("EA content: cancelled".into());
                }
                return Err(err);
            }
            Err(err) => {
                set.abort_all();
                return Err(format!("EA content: task: {err}"));
            }
        }
        on_progress(DownloadProgress {
            files: report.files,
            bytes: report.bytes,
            skipped: report.skipped,
            skipped_bytes: report.skipped_bytes,
            done_bytes: report.bytes + report.skipped_bytes,
            total_files,
            total_bytes,
        });
    }
    if let Some(flag) = cancelled {
        if flag.load(Ordering::Relaxed) {
            return Err("EA content: cancelled".into());
        }
    }
    Ok(report)
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerifyReport {
    pub checked: usize,
    pub ok: usize,
    pub missing: usize,
    pub mismatched: usize,
    pub bytes_checked: u64,
    /// EA anti-cheat titles cannot be repaired from the launcher.
    pub eaac: bool,
}

/// Checks local files against the live package without downloading anything.
///
/// `max_files`, `max_file_bytes` and `max_total_bytes` bound the work so a
/// repair check can sample a large install without reading it all.
pub(crate) async fn verify_install(
    plan: &InstallPlan,
    max_files: usize,
    max_file_bytes: u64,
    max_total_bytes: u64,
) -> Result<VerifyReport, String> {
    let mut report = VerifyReport {
        eaac: plan.eaac,
        ..VerifyReport::default()
    };
    for entry in plan
        .manifest
        .entries
        .iter()
        .filter(|entry| {
            !entry.name.is_empty()
                && !entry.name.ends_with('/')
                && entry.uncompressed > 0
                && entry.uncompressed <= max_file_bytes
        })
        .take(max_files)
    {
        if report.bytes_checked >= max_total_bytes {
            break;
        }
        let path = probe_path(&plan.root, &entry.name)?;
        let Ok(meta) = tokio::fs::metadata(&path).await else {
            report.missing += 1;
            continue;
        };
        report.checked += 1;
        if meta.len() != entry.uncompressed {
            report.mismatched += 1;
            continue;
        }
        if file_crc(&path).await? == entry.crc32 {
            report.ok += 1;
            report.bytes_checked += entry.uncompressed;
        } else {
            report.mismatched += 1;
        }
    }
    Ok(report)
}

async fn graphql(
    access: &str,
    query: &str,
    operation: &str,
    variables: Value,
) -> Result<Value, String> {
    let hash = Sha256::digest(query.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let extensions = json!({
        "persistedQuery": { "version": 1, "sha256Hash": hash }
    });
    let client = client();

    let response = client
        .get(GRAPHQL)
        .query(&[
            ("extensions", extensions.to_string()),
            ("operationName", operation.to_string()),
            ("variables", variables.to_string()),
        ])
        .header("Authorization", format!("Bearer {access}"))
        .send()
        .await
        .map_err(|err| format!("EA content: {err}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|err| err.to_string())?;
    if let Ok(value) = serde_json::from_str::<Value>(&text) {
        if status.is_success() && value.get("errors").is_none() {
            return Ok(value);
        }
    }

    // EA accepts the full query when the persisted hash is not the one it has
    // registered; this is the same fallback the EA client uses.
    let body = json!({
        "extensions": extensions,
        "variables": variables,
        "operationName": operation,
        "query": query,
    });
    let response = client
        .post(GRAPHQL)
        .header("Authorization", format!("Bearer {access}"))
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("EA content: {err}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|err| err.to_string())?;
    let value: Value =
        serde_json::from_str(&text).map_err(|_| format!("EA content: HTTP {status}: {text}"))?;
    if let Some(errors) = value.get("errors") {
        return Err(format!("EA content: GraphQL {operation}: {errors}"));
    }
    if !status.is_success() {
        return Err(format!("EA content: HTTP {status}: {text}"));
    }
    Ok(value)
}

async fn remote_size(client: &reqwest::Client, url: &str) -> Result<u64, String> {
    let head = client
        .head(url)
        .send()
        .await
        .map_err(|err| format!("EA content: {err}"))?;
    if let Some(size) = head.content_length() {
        if size >= 22 {
            return Ok(size);
        }
    }
    let probe = client
        .get(url)
        .header("Range", "bytes=0-0")
        .send()
        .await
        .map_err(|err| format!("EA content: {err}"))?;
    if probe.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(format!(
            "EA content: size probe returned HTTP {}",
            probe.status()
        ));
    }
    probe
        .headers()
        .get("content-range")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.rsplit('/').next())
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| "EA content: package size is unknown".to_string())
}

async fn range_get(
    client: &reqwest::Client,
    url: &str,
    start: u64,
    end: u64,
) -> Result<Vec<u8>, String> {
    if end < start {
        return Err("EA content: invalid range".into());
    }
    let mut attempt = 0u32;
    loop {
        let response = client
            .get(url)
            .header("Range", format!("bytes={start}-{end}"))
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            Err(_error) if attempt < 3 => {
                attempt += 1;
                tokio::time::sleep(std::time::Duration::from_millis(400 * u64::from(attempt)))
                    .await;
                continue;
            }
            Err(error) => return Err(format!("EA content: {error}")),
        };
        if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
            let bytes = match response.bytes().await {
                Ok(bytes) => bytes,
                Err(_error) if attempt < 3 => {
                    attempt += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(400 * u64::from(attempt)))
                        .await;
                    continue;
                }
                Err(error) => return Err(format!("EA content: {error}")),
            };
            if bytes.len() as u64 != end - start + 1 {
                return Err("EA content: short range response".into());
            }
            return Ok(bytes.to_vec());
        }
        if (response.status().is_server_error()
            || response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS)
            && attempt < 3
        {
            attempt += 1;
            tokio::time::sleep(std::time::Duration::from_millis(400 * u64::from(attempt))).await;
            continue;
        }
        return Err(format!(
            "EA content: server did not honour the range (HTTP {})",
            response.status()
        ));
    }
}

struct Eocd {
    central_size: u64,
    central_offset: u64,
}

fn read_eocd(tail: &[u8], tail_offset: u64, archive_size: u64) -> Result<Eocd, String> {
    let position = find_eocd(tail).ok_or("EA content: ZIP end record not found")?;
    let mut central_size = u32_at(tail, position + 12).ok_or("EA content: short EOCD")? as u64;
    let mut central_offset = u32_at(tail, position + 16).ok_or("EA content: short EOCD")? as u64;
    let mut entries = u16_at(tail, position + 10).ok_or("EA content: short EOCD")? as u64;

    if entries == 0xFFFF || central_size == 0xFFFF_FFFF || central_offset == 0xFFFF_FFFF {
        let locator = position
            .checked_sub(20)
            .ok_or("EA content: ZIP64 locator missing")?;
        if u32_at(tail, locator) != Some(ZIP64_LOCATOR_SIG) {
            return Err("EA content: bad ZIP64 locator".into());
        }
        let zip64_offset = u64_at(tail, locator + 8).ok_or("EA content: short locator")?;
        let relative = zip64_offset
            .checked_sub(tail_offset)
            .ok_or("EA content: ZIP64 record outside the tail")? as usize;
        if relative + 56 > tail.len() || u32_at(tail, relative) != Some(ZIP64_EOCD_SIG) {
            return Err("EA content: ZIP64 record outside the tail".into());
        }
        entries = u64_at(tail, relative + 32).ok_or("EA content: short ZIP64 EOCD")?;
        central_size = u64_at(tail, relative + 40).ok_or("EA content: short ZIP64 EOCD")?;
        central_offset = u64_at(tail, relative + 48).ok_or("EA content: short ZIP64 EOCD")?;
        let _ = entries;
    }

    if central_offset
        .checked_add(central_size)
        .map(|end| end > archive_size)
        .unwrap_or(true)
    {
        return Err("EA content: central directory outside the package".into());
    }
    Ok(Eocd {
        central_size,
        central_offset,
    })
}

fn find_eocd(tail: &[u8]) -> Option<usize> {
    let mut position = tail.len().checked_sub(22)?;
    loop {
        if u32_at(tail, position) == Some(EOCD_SIG) {
            let comment_len = u16_at(tail, position + 20)? as usize;
            if position + 22 + comment_len <= tail.len() {
                return Some(position);
            }
        }
        if position == 0 {
            return None;
        }
        position -= 1;
    }
}

fn parse_central_directory(bytes: &[u8]) -> Result<Vec<ZipEntry>, String> {
    let mut entries = Vec::new();
    let mut position = 0usize;
    while position + 46 <= bytes.len() {
        if u32_at(bytes, position) != Some(CENTRAL_SIG) {
            break;
        }
        let compression = u16_at(bytes, position + 10).ok_or("EA content: short entry")?;
        let crc32 = u32_at(bytes, position + 16).ok_or("EA content: short entry")?;
        let mut compressed = u32_at(bytes, position + 20).ok_or("EA content: short entry")? as u64;
        let mut uncompressed = u32_at(bytes, position + 24).ok_or("EA content: short entry")? as u64;
        let name_len = u16_at(bytes, position + 28).ok_or("EA content: short entry")? as usize;
        let extra_len = u16_at(bytes, position + 30).ok_or("EA content: short entry")? as usize;
        let comment_len = u16_at(bytes, position + 32).ok_or("EA content: short entry")? as usize;
        let mut local_offset = u32_at(bytes, position + 42).ok_or("EA content: short entry")? as u64;
        let name_start = position + 46;
        let name_end = name_start + name_len;
        let extra_end = name_end + extra_len;
        if extra_end > bytes.len() {
            return Err("EA content: truncated central directory".into());
        }
        let name = String::from_utf8_lossy(&bytes[name_start..name_end])
            .replace('\\', "/")
            .trim_start_matches('/')
            .to_string();
        let extra = &bytes[name_end..extra_end];

        if uncompressed == 0xFFFF_FFFF || compressed == 0xFFFF_FFFF || local_offset == 0xFFFF_FFFF {
            let mut cursor = 0usize;
            while cursor + 4 <= extra.len() {
                let id = u16_at(extra, cursor).unwrap_or(0);
                let size = u16_at(extra, cursor + 2).unwrap_or(0) as usize;
                let data = &extra[cursor + 4..(cursor + 4 + size).min(extra.len())];
                if id == 0x0001 {
                    let mut offset = 0usize;
                    if uncompressed == 0xFFFF_FFFF {
                        uncompressed = u64_at(data, offset).ok_or("EA content: short ZIP64 extra")?;
                        offset += 8;
                    }
                    if compressed == 0xFFFF_FFFF {
                        compressed = u64_at(data, offset).ok_or("EA content: short ZIP64 extra")?;
                        offset += 8;
                    }
                    if local_offset == 0xFFFF_FFFF {
                        local_offset = u64_at(data, offset).ok_or("EA content: short ZIP64 extra")?;
                    }
                    break;
                }
                cursor += 4 + size;
            }
        }

        entries.push(ZipEntry {
            name,
            compression,
            crc32,
            compressed,
            uncompressed,
            local_offset,
        });
        position = extra_end + comment_len;
    }
    if entries.is_empty() {
        return Err("EA content: central directory is empty".into());
    }
    Ok(entries)
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn u64_at(bytes: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(bytes.get(at..at + 8)?.try_into().ok()?))
}

/// A safe relative path for a probe download.
pub(crate) fn probe_path(root: &Path, name: &str) -> Result<PathBuf, String> {
    let mut path = root.to_path_buf();
    for part in name.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains(':') {
            return Err("EA content: unsafe entry name".into());
        }
        path.push(part);
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn central_entry(name: &str, crc: u32) -> Vec<u8> {
        let name = name.as_bytes();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&CENTRAL_SIG.to_le_bytes());
        bytes.extend_from_slice(&20u16.to_le_bytes()); // version made by
        bytes.extend_from_slice(&20u16.to_le_bytes()); // version needed
        bytes.extend_from_slice(&0u16.to_le_bytes()); // flags
        bytes.extend_from_slice(&8u16.to_le_bytes()); // deflate
        bytes.extend_from_slice(&0u16.to_le_bytes()); // time
        bytes.extend_from_slice(&0u16.to_le_bytes()); // date
        bytes.extend_from_slice(&crc.to_le_bytes());
        bytes.extend_from_slice(&10u32.to_le_bytes()); // compressed
        bytes.extend_from_slice(&20u32.to_le_bytes()); // uncompressed
        bytes.extend_from_slice(&(name.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes()); // extra
        bytes.extend_from_slice(&0u16.to_le_bytes()); // comment
        bytes.extend_from_slice(&0u16.to_le_bytes()); // disk
        bytes.extend_from_slice(&0u16.to_le_bytes()); // internal
        bytes.extend_from_slice(&0u32.to_le_bytes()); // external
        bytes.extend_from_slice(&0u32.to_le_bytes()); // local offset
        bytes.extend_from_slice(name);
        bytes
    }

    #[test]
    fn a_central_entry_reads_its_sizes_and_name() {
        let entry = central_entry("Support/readme.txt", 0x1234_5678);
        let entries = parse_central_directory(&entry).expect("entry");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "Support/readme.txt");
        assert_eq!(entries[0].crc32, 0x1234_5678);
        assert_eq!(entries[0].compressed, 10);
        assert_eq!(entries[0].uncompressed, 20);
    }

    #[test]
    fn an_eocd_is_found_at_the_end_of_the_tail() {
        let mut tail = vec![0u8; 30];
        let position = 4;
        tail[position..position + 4].copy_from_slice(&EOCD_SIG.to_le_bytes());
        tail[position + 10..position + 12].copy_from_slice(&1u16.to_le_bytes());
        tail[position + 12..position + 16].copy_from_slice(&100u32.to_le_bytes());
        tail[position + 16..position + 20].copy_from_slice(&200u32.to_le_bytes());
        let eocd = read_eocd(&tail, 0, 1000).expect("eocd");
        assert_eq!(eocd.central_size, 100);
        assert_eq!(eocd.central_offset, 200);
    }

    #[test]
    fn probe_paths_cannot_escape_the_root() {
        let root = Path::new("C:/temp");
        assert!(probe_path(root, "../x").is_err());
        assert!(probe_path(root, "a/../../x").is_err());
        assert!(probe_path(root, "Data/file.bin").is_ok());
    }

    #[test]
    fn eaac_titles_are_recognised_from_their_manifest() {
        assert!(manifest_needs_eaac(
            "<filePath>EAAntiCheat.GameServiceLauncher.exe</filePath>"
        ));
        assert!(manifest_needs_eaac("requires EA Anti-Cheat"));
        assert!(!manifest_needs_eaac(
            "<filePath>__Installer/touchup.exe</filePath>"
        ));
    }

    #[test]
    fn ooa_activation_files_are_recognised_from_the_package() {
        assert!(entry_needs_ooa(
            "Haze1/Binaries/Win64/Core/Activation64.dll"
        ));
        assert!(entry_needs_ooa(
            r"Haze1\Binaries\Win64\Core\Activation.dll"
        ));
        assert!(entry_needs_ooa("Core/ActivationUI.exe"));
        assert!(!entry_needs_ooa("Haze1/Binaries/Win64/AWayOut.exe"));
        assert!(!entry_needs_ooa("Core/Activation.txt"));
    }

    #[test]
    fn download_links_keep_the_optional_sync_url() {
        let value = serde_json::json!({
            "data": {
                "downloadUrl": {
                    "url": "https://cdn.example/full.zip",
                    "syncUrl": "https://cdn.example/SyncPackage.zip"
                }
            }
        });
        let links = parse_download_links(&value).expect("links");
        assert_eq!(links.url, "https://cdn.example/full.zip");
        assert_eq!(
            links.sync_url.as_deref(),
            Some("https://cdn.example/SyncPackage.zip")
        );

        let no_sync = serde_json::json!({
            "data": { "downloadUrl": { "url": "https://cdn.example/full.zip" } }
        });
        assert_eq!(
            parse_download_links(&no_sync).expect("links").sync_url,
            None
        );
    }

    #[test]
    fn the_sync_package_keeps_full_files_and_drops_patch_metadata() {
        let entry = |name: &str, uncompressed: u64| ZipEntry {
            name: name.into(),
            compression: 0,
            crc32: 0,
            compressed: uncompressed,
            uncompressed,
            local_offset: 0,
        };
        let manifest = ZipManifest {
            entries: vec![
                entry("Engine/", 0),
                entry("Engine/Game.exe", 128),
                entry("Engine/Game.exe.eaPatchDiff", 12),
                entry("patch-1.eaPatchInfo", 20),
                entry("patch-1.eaPatchImpl", 30),
            ],
            ..ZipManifest::default()
        };
        let files = sync_file_entries(&manifest);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "Engine/Game.exe");
    }

    #[test]
    fn only_the_dip_manifest_is_a_modern_package() {
        assert!(is_dip_manifest("<DiPManifest version=\"4.0\"></DiPManifest>"));
        assert!(!is_dip_manifest("<game><contentID>1</contentID></game>"));
        assert!(!is_dip_manifest(""));
    }

    #[test]
    fn a_pre_dip_executable_is_installable() {
        assert!(legacy_executable(
            "<game manifestVersion=\"2.1\"><executable><filePath>/setup.exe</filePath></executable></game>"
        ));
        assert!(!legacy_executable("<game></game>"));
    }

    #[test]
    fn network_failures_are_retryable_but_crc_mismatches_are_not() {
        assert!(transient_error("EA content: error sending request for url (…)"));
        assert!(transient_error("EA content: HTTP 503"));
        assert!(!transient_error("EA content: CRC mismatch"));
        assert!(!transient_error("EA content: unsupported compression 14"));
    }

    #[test]
    fn expired_or_forbidden_urls_are_recognised() {
        assert!(auth_error("EA content: server did not honour the range (HTTP 403 Forbidden)"));
        assert!(auth_error("HTTP 401 Unauthorized"));
        assert!(auth_error("the signed URL has expired"));
        assert!(!auth_error("EA content: CRC mismatch"));
    }

    #[test]
    fn byte_sizes_are_readable() {
        assert_eq!(human_bytes(2 * 1024 * 1024 * 1024), "2.0 GB");
        assert_eq!(human_bytes(512 * 1024 * 1024), "512 MB");
    }

    #[test]
    #[ignore = "talks to EA's content service and downloads a few small entries"]
    fn manual_content_batch() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let result = runtime.block_on(async {
            let access = super::super::ea_login::ensure_access().await?;
            let root = std::env::temp_dir().join("efxlve-ea-batch");
            let _ = std::fs::remove_dir_all(&root);
            let plan = plan_install(&access, "Origin.OFR.50.0002412", &root).await?;
            println!(
                "plan: offer={} build={} version={} entries={} total={}",
                plan.offer_id,
                plan.build_id,
                plan.version,
                plan.manifest.entries.len(),
                plan.total_compressed()
            );
            let small: Vec<ZipEntry> = plan
                .manifest
                .entries
                .iter()
                .filter(|entry| entry.compressed > 0 && entry.compressed <= 64 * 1024)
                .take(12)
                .cloned()
                .collect();
            println!("batch: {} small entries", small.len());
            let mut updates = Vec::new();
            let first = download_entries_with_progress(
                &plan.download_url,
                &plan.root,
                &small,
                |progress| updates.push(progress),
            )
            .await?;
            println!("first: {first:?}");
            println!(
                "progress ticks: {} last: {:?}",
                updates.len(),
                updates.last()
            );
            let second = download_entries(&plan.download_url, &plan.root, &small).await?;
            println!("second: {second:?}");
            let expected: u64 = small.iter().map(|entry| entry.uncompressed).sum();
            println!("expected uncompressed: {expected}");
            if first.bytes != expected {
                return Err(format!(
                    "batch bytes {} != expected {expected}",
                    first.bytes
                ));
            }
            if updates.last().map(|progress| progress.files) != Some(small.len()) {
                return Err(format!("progress did not reach the last file: {updates:?}"));
            }
            if second.files != 0 || second.bytes != 0 || second.skipped != small.len() {
                return Err(format!(
                    "resume did not skip the cached files: {second:?}"
                ));
            }
            Ok::<(), String>(())
        });
        println!("result: {result:?}");
    }

    #[test]
    #[ignore = "downloads a whole EA package into the temp folder"]
    fn manual_full_package() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .expect("runtime");
        let result = runtime.block_on(async {
            let access = super::super::ea_login::ensure_access().await?;
            let root = std::env::temp_dir().join("opencode").join("ea-mirror");
            let plan = plan_install(&access, "DR:106999100", &root).await?;
            println!(
                "plan: offer={} version={} entries={} compressed={} uncompressed={} root={}",
                plan.offer_id,
                plan.version,
                plan.manifest.entries.len(),
                plan.total_compressed(),
                plan.total_uncompressed(),
                plan.root.display()
            );
            let mut last = std::time::Instant::now();
            let report = download_entries_with_progress(
                &plan.download_url,
                &plan.root,
                &plan.manifest.entries,
                |progress| {
                    if last.elapsed().as_secs() >= 5 {
                        println!(
                            "progress: {}/{} files {} / {} bytes",
                            progress.files + progress.skipped,
                            progress.total_files,
                            progress.done_bytes,
                            progress.total_bytes
                        );
                        last = std::time::Instant::now();
                    }
                },
            )
            .await?;
            println!("report: {report:?}");
            if report.bytes + report.skipped_bytes != plan.total_uncompressed() {
                return Err(format!(
                    "installed {} bytes, expected {}",
                    report.bytes + report.skipped_bytes,
                    plan.total_uncompressed()
                ));
            }
            Ok::<(), String>(())
        });
        println!("result: {result:?}");
        assert!(result.is_ok(), "full package failed: {result:?}");
    }

    #[test]
    #[ignore = "checks the legacy-package guard against the full package"]
    fn manual_full_package_touchup() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .expect("runtime");
        let root = std::env::temp_dir().join("opencode").join("ea-mirror");
        let result = runtime.block_on(async {
            let access = super::super::ea_login::ensure_access().await?;
            let cancelled = Arc::new(AtomicBool::new(false));
            let install = super::super::ea_install::install_with_progress(
                &access,
                "DR:106999100",
                &root,
                "en_US",
                &cancelled,
                |tick| println!("tick: {} {:?}", tick.phase, tick.progress),
            )
            .await;
            println!("install: {install:?}");
            if !matches!(&install, Err(error) if error.contains("Legacy EA installers")) {
                return Err(format!("expected the legacy guard, got {install:?}"));
            }
            let probe = super::super::ea_direct::plan(
                &root.to_string_lossy(),
                "mirrors_edge_na",
            );
            println!("launch plan: {probe:?}");
            Ok::<(), String>(())
        });
        println!("result: {result:?}");
        assert!(result.is_ok(), "legacy guard test failed: {result:?}");
    }

    #[test]
    #[ignore = "expects the full package from manual_full_package in the temp folder"]
    fn manual_full_package_resume() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .expect("runtime");
        let result = runtime.block_on(async {
            let access = super::super::ea_login::ensure_access().await?;
            let root = std::env::temp_dir().join("opencode").join("ea-mirror");
            let plan = plan_install(&access, "DR:106999100", &root).await?;
            println!(
                "plan: entries={} uncompressed={}",
                plan.manifest.entries.len(),
                plan.total_uncompressed()
            );
            let report =
                download_entries(&plan.download_url, &plan.root, &plan.manifest.entries).await?;
            println!("resume: {report:?}");
            if report.files != 0 || report.bytes != 0 {
                return Err(format!("resume downloaded again: {report:?}"));
            }
            if report.skipped_bytes != plan.total_uncompressed() {
                return Err(format!(
                    "resume verified {} bytes, expected {}",
                    report.skipped_bytes,
                    plan.total_uncompressed()
                ));
            }
            Ok::<(), String>(())
        });
        println!("result: {result:?}");
        assert!(result.is_ok(), "resume failed: {result:?}");
    }

    #[test]
    #[ignore = "talks to EA's content service for the legacy Mirror's Edge package"]
    fn manual_legacy_package() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let result = runtime.block_on(async {
            let access = super::super::ea_login::ensure_access().await?;
            let plan = plan_install(
                &access,
                "DR:106999100",
                &std::env::temp_dir().join("efxlve-ea-legacy-probe"),
            )
            .await?;
            println!(
                "legacy={} installable={} entries={}",
                plan.legacy,
                plan.legacy_installable,
                plan.manifest.entries.len()
            );
            Ok::<(), String>(())
        });
        println!("result: {result:?}");
        assert!(result.is_ok());
    }

    #[test]
    #[ignore = "talks to EA's content service for the pre-DiP Dead Space 2 package"]
    fn manual_dead_space_installable_package() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let result = runtime.block_on(async {
            let access = super::super::ea_login::ensure_access().await?;
            let plan = plan_install(
                &access,
                "OFB-EAST:55619",
                &std::env::temp_dir().join("efxlve-ea-dead-space-probe"),
            )
            .await?;
            println!(
                "legacy={} installable={} eaac={} entries={} compressed={}",
                plan.legacy,
                plan.legacy_installable,
                plan.eaac,
                plan.manifest.entries.len(),
                plan.total_compressed()
            );
            Ok::<(), String>(())
        });
        println!("result: {result:?}");
        assert!(result.is_ok());
    }

    #[test]
    #[ignore = "talks to EA's content service for every owned offer"]
    fn manual_content_sizes() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let result = runtime.block_on(async {
            let access = super::super::ea_login::ensure_access().await?;
            let mut rows = Vec::new();
            for game in super::super::ea_login::cached_owned() {
                match available_builds(&access, &game.id).await {
                    Ok(builds) => {
                        let Some(build) = builds
                            .iter()
                            .find(|build| build.download_type.eq_ignore_ascii_case("live"))
                            .or_else(|| builds.first())
                        else {
                            rows.push((0, game.name, game.id, "no build".to_string()));
                            continue;
                        };
                        match download_url(&access, &game.id, &build.build_id).await {
                            Ok(url) => match remote_size(&client(), &url).await {
                                Ok(size) => rows.push((size, game.name, game.id, build.game_version.clone())),
                                Err(error) => rows.push((0, game.name, game.id, error)),
                            },
                            Err(error) => rows.push((0, game.name, game.id, error)),
                        }
                    }
                    Err(error) => rows.push((0, game.name, game.id, error)),
                }
            }
            rows.sort_by_key(|row| row.0);
            for (size, name, id, note) in &rows {
                println!("{size:>14}  {name:<38} {id:<26} {note}");
            }
            Ok::<(), String>(())
        });
        println!("result: {result:?}");
    }

    #[test]
    #[ignore = "compares an installed EA game against the live package"]
    fn manual_content_verify() {
        let root = std::env::var("EFXLVE_EA_PROBE")
            .unwrap_or_else(|_| "C:\\Program Files\\EA Games\\Battlefield 2042".to_string());
        let offer = std::env::var("EFXLVE_EA_OFFER")
            .unwrap_or_else(|_| "Origin.OFR.50.0004540".to_string());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let result = runtime.block_on(async {
            let access = super::super::ea_login::ensure_access().await?;
            let plan = plan_install(&access, &offer, Path::new(&root)).await?;
            println!(
                "plan: offer={} version={} entries={} root={}",
                plan.offer_id,
                plan.version,
                plan.manifest.entries.len(),
                plan.root.display()
            );
            // Sample at most 2,000 files of 8 MB each and 512 MB in total.
            let report = verify_install(&plan, 2_000, 8 * 1024 * 1024, 512 * 1024 * 1024).await?;
            for entry in plan
                .manifest
                .entries
                .iter()
                .filter(|entry| !entry.name.is_empty() && !entry.name.ends_with('/'))
                .take(8)
            {
                let path = probe_path(&plan.root, &entry.name)?;
                println!(
                    "sample: {} exists={} expected={}",
                    entry.name,
                    path.is_file(),
                    entry.uncompressed
                );
            }
            let mut shown = 0usize;
            for entry in plan
                .manifest
                .entries
                .iter()
                .filter(|entry| !entry.name.is_empty() && !entry.name.ends_with('/'))
            {
                if shown == 10 {
                    break;
                }
                let path = probe_path(&plan.root, &entry.name)?;
                if !path.is_file() {
                    println!("missing sample: {}", entry.name);
                    shown += 1;
                }
            }
            println!(
                "verify: checked={} ok={} missing={} mismatched={} bytes={}",
                report.checked,
                report.ok,
                report.missing,
                report.mismatched,
                report.bytes_checked
            );
            if report.checked == 0 && report.missing == 0 {
                return Err("verify sampled no files".into());
            }
            Ok::<(), String>(())
        });
        println!("result: {result:?}");
    }

    #[test]
    #[ignore = "talks to EA's content service with the signed-in account"]
    fn manual_content_probe() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let result = runtime.block_on(async {
            let access = super::super::ea_login::ensure_access().await?;
            let offer = "Origin.OFR.50.0002412"; // A Way Out, owned and DiP
            let builds = available_builds(&access, offer).await?;
            println!("builds: {builds:#?}");
            let live = builds
                .iter()
                .find(|build| build.download_type.eq_ignore_ascii_case("Live"))
                .or_else(|| builds.first())
                .ok_or_else(|| "no builds".to_string())?;
            let url = download_url(&access, offer, &live.build_id).await?;
            println!("download url: {url}");
            let manifest = read_manifest(&url).await?;
            println!(
                "entries: {} archive: {} central: {} at {} total compressed: {}",
                manifest.entries.len(),
                manifest.archive_size,
                manifest.central_size,
                manifest.central_offset,
                manifest.total_compressed()
            );
            let entry = manifest
                .smallest()
                .ok_or_else(|| "no file entry".to_string())?;
            println!("smallest: {entry:?}");
            let root = std::env::temp_dir().join("efxlve-ea-content");
            let destination = probe_path(&root, &entry.name)?;
            let bytes = download_entry(&url, entry, &destination).await?;
            println!("downloaded {destination:?}: {bytes} bytes");
            Ok::<(), String>(())
        });
        println!("result: {result:?}");
    }

    #[tokio::test]
    #[ignore = "talks to EA's content service with the signed-in account"]
    async fn manual_sync_url_probe() {
        let access = super::super::ea_login::ensure_access().await.expect("access");
        let offer = "Origin.OFR.50.0002412";
        let builds = available_builds(&access, offer).await.expect("builds");
        let live = builds
            .iter()
            .find(|build| build.download_type.eq_ignore_ascii_case("Live"))
            .or_else(|| builds.first())
            .expect("live build");
        let links = download_links(&access, offer, &live.build_id)
            .await
            .expect("links");
        println!("full={}", links.url);
        println!("sync={:?}", links.sync_url);
        if let Some(sync) = &links.sync_url {
            let sync_manifest = read_manifest(sync).await.expect("sync manifest");
            println!("sync entries: {}", sync_manifest.entries.len());
            let files = sync_file_entries(&sync_manifest);
            println!("sync full files: {}", files.len());
            assert!(!files.is_empty());
            assert!(files.iter().all(|entry| !entry.name.ends_with(".eaPatchDiff")));
            assert!(files.iter().all(|entry| !entry.name.ends_with("eaPatchInfo")));
            assert!(files.iter().all(|entry| !entry.name.ends_with("eaPatchImpl")));
            let temp = std::env::temp_dir().join("efxlve-ea-sync-probe");
            std::fs::create_dir_all(&temp).expect("temp");
            for (label, suffix) in [
                ("metadata", "eaPatchInfo"),
                ("impl", "eaPatchImpl"),
                ("diff", "ICU.tps.eaPatchDiff"),
                ("new", "ICU.tps"),
            ] {
                let Some(entry) = sync_manifest
                    .entries
                    .iter()
                    .find(|entry| entry.name.ends_with(suffix))
                else {
                    continue;
                };
                let dest = temp.join(format!("{label}-{}", suffix.replace('/', "_")));
                download_entry(sync, entry, &dest)
                    .await
                    .expect("download sync entry");
                let data = std::fs::read(&dest).expect("read sync entry");
                let head = &data[..data.len().min(96)];
                println!(
                    "{label} name={} len={} head={:02x?}",
                    entry.name,
                    data.len(),
                    head
                );
                println!(
                    "{label} ascii={}",
                    String::from_utf8_lossy(head).replace('\0', ".")
                );
            }
            let local = std::env::var_os("USERPROFILE")
                .map(std::path::PathBuf::from)
                .unwrap_or_default()
                .join("Games/EA/A Way Out/Engine/Binaries/ThirdParty/ICU/ICU.tps");
            if let Ok(data) = std::fs::read(&local) {
                let head = &data[..data.len().min(96)];
                println!("local ICU.tps len={} head={:02x?}", data.len(), head);
            }
        }
    }

    #[tokio::test]
    #[ignore = "queries EA's content service for the A Way Out build list"]
    async fn manual_a_way_out_builds() {
        let access = super::super::ea_login::ensure_access().await.expect("access");
        let builds = available_builds(&access, "Origin.OFR.50.0002412")
            .await
            .expect("builds");
        for build in &builds {
            match download_links(&access, "Origin.OFR.50.0002412", &build.build_id).await {
                Ok(links) => {
                    let size = remote_size(&client(), &links.url).await.unwrap_or(0);
                    println!(
                        "build: version={} id={} type={} live={} size={} ({:.2} GB) sync={:?}",
                        build.game_version,
                        build.build_id,
                        build.download_type,
                        build.live_date,
                        size,
                        size as f64 / 1024.0 / 1024.0 / 1024.0,
                        links.sync_url
                    );
                }
                Err(error) => println!(
                    "build: version={} id={} links failed: {error}",
                    build.game_version, build.build_id
                ),
            }
        }
        assert!(!builds.is_empty());
    }

    #[tokio::test]
    #[ignore = "reads the older A Way Out sync package metadata"]
    async fn manual_old_sync_probe() {
        let access = super::super::ea_login::ensure_access().await.expect("access");
        let builds = available_builds(&access, "Origin.OFR.50.0002412")
            .await
            .expect("builds");
        let old = builds
            .iter()
            .find(|build| build.game_version == "1.0.62.0")
            .expect("1.0.62.0 build");
        let links = download_links(&access, "Origin.OFR.50.0002412", &old.build_id)
            .await
            .expect("old links");
        let sync = links.sync_url.expect("old sync url");
        let manifest = read_manifest(&sync).await.expect("old sync manifest");
        let files = sync_file_entries(&manifest);
        println!(
            "old sync entries: {} full files: {}",
            manifest.entries.len(),
            files.len()
        );
        let temp = std::env::temp_dir().join("efxlve-ea-old-sync");
        std::fs::create_dir_all(&temp).expect("temp");
        for (label, suffix) in [("metadata", "eapatchinfo"), ("impl", "eapatchimpl")] {
            let Some(entry) = manifest
                .entries
                .iter()
                .find(|entry| entry.name.to_ascii_lowercase().ends_with(suffix))
            else {
                continue;
            };
            let dest = temp.join(format!("{label}.dat"));
            download_entry(&sync, entry, &dest)
                .await
                .expect("download old metadata");
            let data = std::fs::read(&dest).expect("read old metadata");
            let head = &data[..data.len().min(180)];
            println!(
                "{label} name={} len={} ascii={}",
                entry.name,
                data.len(),
                String::from_utf8_lossy(head).replace('\0', ".")
            );
        }
        if let Some(entry) = manifest
            .entries
            .iter()
            .find(|entry| entry.name.ends_with(".eaPatchDiff"))
        {
            let dest = temp.join("one.eaPatchDiff");
            download_entry(&sync, entry, &dest)
                .await
                .expect("download old diff");
            let data = std::fs::read(&dest).expect("read old diff");
            let head = &data[..data.len().min(64)];
            println!(
                "diff name={} len={} head={:02x?}",
                entry.name,
                data.len(),
                head
            );
        }
    }
}
