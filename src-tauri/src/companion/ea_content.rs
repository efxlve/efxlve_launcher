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

use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

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
/// the entry list read from the ZIP central directory.
#[derive(Debug, Clone)]
pub(crate) struct InstallPlan {
    pub offer_id: String,
    pub build_id: String,
    pub version: String,
    pub download_url: String,
    pub root: PathBuf,
    pub manifest: ZipManifest,
}

impl InstallPlan {
    pub(crate) fn total_compressed(&self) -> u64 {
        self.manifest.total_compressed()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DownloadReport {
    pub files: usize,
    pub bytes: u64,
    pub skipped: usize,
}

impl ZipManifest {
    pub(crate) fn total_compressed(&self) -> u64 {
        self.entries.iter().map(|entry| entry.compressed).sum()
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
pub(crate) async fn download_url(
    access: &str,
    offer_id: &str,
    build_id: &str,
) -> Result<String, String> {
    let value = graphql(
        access,
        DOWNLOAD_URL,
        "downloadUrl",
        json!({ "offerId": offer_id, "buildId": build_id }),
    )
    .await?;
    value
        .pointer("/data/downloadUrl/url")
        .and_then(Value::as_str)
        .filter(|url| url.starts_with("https://"))
        .map(str::to_string)
        .ok_or_else(|| "EA content: downloadUrl missing".to_string())
}

/// Resolves the live build and its package for one offer.
pub(crate) async fn plan_install(
    access: &str,
    offer_id: &str,
    root: &Path,
) -> Result<InstallPlan, String> {
    let builds = available_builds(access, offer_id).await?;
    let build = builds
        .iter()
        .find(|build| build.download_type.eq_ignore_ascii_case("live"))
        .or_else(|| builds.first())
        .ok_or_else(|| "EA content: no build for this offer".to_string())?;
    let url = download_url(access, offer_id, &build.build_id).await?;
    let manifest = read_manifest(&url).await?;
    Ok(InstallPlan {
        offer_id: offer_id.to_string(),
        build_id: build.build_id.clone(),
        version: build.game_version.clone(),
        download_url: url,
        root: root.to_path_buf(),
        manifest,
    })
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
    download_entry_with_client(&client, url, entry, destination).await
}

async fn download_entry_with_client(
    client: &reqwest::Client,
    url: &str,
    entry: &ZipEntry,
    destination: &Path,
) -> Result<u64, String> {
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

    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("EA content: {err}"))?;
    }
    std::fs::write(destination, &data).map_err(|err| format!("EA content: {err}"))?;
    Ok(data.len() as u64)
}

/// Downloads a set of entries with four range workers.
pub(crate) async fn download_entries(
    url: &str,
    root: &Path,
    entries: &[ZipEntry],
) -> Result<DownloadReport, String> {
    let client = client();
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
    let mut set = tokio::task::JoinSet::new();
    let mut skipped = 0usize;

    for entry in entries {
        if entry.name.is_empty() || entry.name.ends_with('/') {
            skipped += 1;
            continue;
        }
        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|err| format!("EA content: {err}"))?;
        let client = client.clone();
        let url = url.to_string();
        let root = root.to_path_buf();
        let entry = entry.clone();
        set.spawn(async move {
            let _permit = permit;
            let destination = probe_path(&root, &entry.name)?;
            if entry.compressed == 0 {
                if let Some(parent) = destination.parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|err| format!("EA content: {err}"))?;
                }
                tokio::fs::write(&destination, [])
                    .await
                    .map_err(|err| format!("EA content: {err}"))?;
                return Ok::<u64, String>(0);
            }
            download_entry_with_client(&client, &url, &entry, &destination).await
        });
    }

    let mut report = DownloadReport {
        skipped,
        ..DownloadReport::default()
    };
    while let Some(result) = set.join_next().await {
        match result {
            Ok(Ok(bytes)) => {
                report.files += 1;
                report.bytes += bytes;
            }
            Ok(Err(err)) => return Err(err),
            Err(err) => return Err(format!("EA content: task: {err}")),
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
    let response = client
        .get(url)
        .header("Range", format!("bytes={start}-{end}"))
        .send()
        .await
        .map_err(|err| format!("EA content: {err}"))?;
    if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(format!(
            "EA content: server did not honour the range (HTTP {})",
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("EA content: {err}"))?;
    if bytes.len() as u64 != end - start + 1 {
        return Err("EA content: short range response".into());
    }
    Ok(bytes.to_vec())
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
            let report = download_entries(&plan.download_url, &plan.root, &small).await?;
            println!("report: {report:?}");
            let expected: u64 = small.iter().map(|entry| entry.uncompressed).sum();
            println!("expected uncompressed: {expected}");
            if report.bytes != expected {
                return Err(format!(
                    "batch bytes {} != expected {expected}",
                    report.bytes
                ));
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
}
