//! Direct install from Ubisoft's CDN.
//!
//! The flow is the one YoobieRE documented and Optima proved:
//! ownership token -> download-service session -> signed URL for the manifest
//! -> signed URLs for the slices. Slices are compressed, not encrypted, and
//! carry both a compressed and a decompressed SHA-1. Files are written through
//! a `.efxlve-part` temp file so resume never trusts a half-written file.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures::StreamExt;
use serde::Serialize;
use sha1::{Digest, Sha1};

use super::manifest::{self, Manifest, ManifestFile, ManifestSlice};
use super::wire;
use crate::companion::{ubi_installs, ubisoft};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallProgress {
    pub product_id: u32,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub file: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallSummary {
    pub product_id: u32,
    pub name: String,
    pub install_dir: String,
    pub files: usize,
    pub bytes: u64,
    pub skipped_files: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallPlan {
    pub product_id: u32,
    pub name: String,
    pub manifest: String,
    pub install_dir: String,
    pub files: usize,
    pub slices: usize,
    pub bytes: u64,
    pub compression: String,
    pub slice_layout: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SliceLayout {
    V3Bucket,
    Flat,
}

impl SliceLayout {
    fn label(self) -> &'static str {
        match self {
            Self::V3Bucket => "slices_v3",
            Self::Flat => "slices",
        }
    }
}

fn slice_path(layout: SliceLayout, hash_upper: &str) -> String {
    match layout {
        SliceLayout::V3Bucket => format!(
            "slices_v3/{}/{}",
            manifest::hash_path_char(hash_upper),
            hash_upper
        ),
        SliceLayout::Flat => format!("slices/{hash_upper}"),
    }
}

fn hash_for_slice(slice: &ManifestSlice) -> String {
    if !slice.download_sha1.is_empty() {
        manifest::hex_upper(&slice.download_sha1)
    } else {
        manifest::hex_upper(&slice.content_sha1)
    }
}

fn cancel_set() -> &'static Mutex<HashSet<u32>> {
    static SET: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Ask a running install to stop after the current slice. The part file stays
/// on disk, so the next install resumes from it.
pub(crate) fn cancel(product_id: u32) {
    if let Ok(mut set) = cancel_set().lock() {
        set.insert(product_id);
    }
}

fn clear_cancel(product_id: u32) {
    if let Ok(mut set) = cancel_set().lock() {
        set.remove(&product_id);
    }
}

fn cancelled(product_id: u32) -> bool {
    cancel_set()
        .lock()
        .map(|set| set.contains(&product_id))
        .unwrap_or(false)
}

fn sha1_hex(data: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(data);
    manifest::hex_upper(&hasher.finalize())
}

fn decompress(method: i32, data: &[u8]) -> Result<Vec<u8>, String> {
    if method == 3 {
        zstd::decode_all(data).map_err(|e| format!("zstd: {e}"))
    } else if method == 1 {
        let looks_zlib = data.len() >= 2 && data[0] == 0x78;
        let raw = |bytes: &[u8]| -> std::io::Result<Vec<u8>> {
            let mut out = Vec::new();
            flate2::read::DeflateDecoder::new(bytes).read_to_end(&mut out)?;
            Ok(out)
        };
        let zlib = |bytes: &[u8]| -> std::io::Result<Vec<u8>> {
            let mut out = Vec::new();
            flate2::read::ZlibDecoder::new(bytes).read_to_end(&mut out)?;
            Ok(out)
        };
        let attempt = if looks_zlib {
            zlib(data).or_else(|_| raw(data))
        } else {
            raw(data).or_else(|_| zlib(data))
        };
        attempt.map_err(|e| format!("deflate: {e}"))
    } else {
        Ok(data.to_vec())
    }
}

fn verify_and_decompress(
    method: i32,
    raw: &[u8],
    slice: &ManifestSlice,
    file_name: &str,
    index: usize,
) -> Result<Vec<u8>, String> {
    if let Some(expected) = slice.download_size {
        if raw.len() as u32 != expected {
            return Err(format!(
                "integrity: {file_name} slice {index}: compressed size {} != {expected}",
                raw.len()
            ));
        }
    }
    if !slice.download_sha1.is_empty() {
        let got = sha1_hex(raw);
        let want = manifest::hex_upper(&slice.download_sha1);
        if got != want {
            return Err(format!(
                "integrity: {file_name} slice {index}: compressed sha1 {got} != {want}"
            ));
        }
    }
    let out = decompress(method, raw)?;
    if out.len() as u32 != slice.size {
        return Err(format!(
            "integrity: {file_name} slice {index}: size {} != {}",
            out.len(),
            slice.size
        ));
    }
    if !slice.content_sha1.is_empty() {
        let got = sha1_hex(&out);
        let want = manifest::hex_upper(&slice.content_sha1);
        if got != want {
            return Err(format!(
                "integrity: {file_name} slice {index}: content sha1 {got} != {want}"
            ));
        }
    }
    Ok(out)
}

async fn fetch_slice(
    client: &reqwest::Client,
    url: &str,
    slice: &ManifestSlice,
    method: i32,
    file_name: &str,
    index: usize,
) -> Result<Vec<u8>, String> {
    let mut attempt = 0u32;
    loop {
        match client.get(url).send().await {
            Ok(response) => match response.error_for_status() {
                Ok(response) => match response.bytes().await {
                    Ok(bytes) => {
                        return verify_and_decompress(method, &bytes, slice, file_name, index)
                    }
                    Err(error) => {
                        attempt += 1;
                        if attempt >= 3 {
                            return Err(format!(
                                "reading {file_name} slice {index}: {error}"
                            ));
                        }
                    }
                },
                Err(error) => {
                    attempt += 1;
                    if attempt >= 3 {
                        return Err(format!("fetching {file_name} slice {index}: {error}"));
                    }
                }
            },
            Err(error) => {
                attempt += 1;
                if attempt >= 3 {
                    return Err(format!("fetching {file_name} slice {index}: {error}"));
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

async fn sign_paths(
    demux: &mut wire::Demux,
    download: &mut wire::DownloadService,
    product_id: u32,
    paths: &[String],
) -> Result<Vec<String>, String> {
    let mut urls = Vec::with_capacity(paths.len());
    for chunk in paths.chunks(100) {
        let signed = download.sign(demux, product_id, chunk).await?;
        if signed.len() != chunk.len() {
            return Err(format!(
                "Ubisoft signed {} URLs for {} paths",
                signed.len(),
                chunk.len()
            ));
        }
        urls.extend(signed);
    }
    Ok(urls)
}

/// Sign a window, rebuilding the Demux socket and its ownership/download
/// services when the long-lived session drops. A large install outlives the
/// first ticket and ownership token, so both are re-minted on every retry.
async fn sign_with_reconnect(
    demux: &mut wire::Demux,
    download: &mut wire::DownloadService,
    product_id: u32,
    paths: &[String],
) -> Result<Vec<String>, String> {
    let mut last = String::new();
    for attempt in 0..3u32 {
        match sign_paths(demux, download, product_id, paths).await {
            Ok(urls) => return Ok(urls),
            Err(error) => {
                last = error;
                if attempt == 2 {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(2 + u64::from(attempt) * 2)).await;
                let (fresh, _) = super::connect()
                    .await
                    .map_err(|error| format!("{last}; Demux reconnect failed: {error}"))?;
                *demux = fresh;
                let token = demux
                    .ownership_token(product_id)
                    .await
                    .map_err(|error| format!("{last}; ownership token refresh failed: {error}"))?;
                *download = demux
                    .download_service(&token)
                    .await
                    .map_err(|error| format!("{last}; download service reopen failed: {error}"))?;
            }
        }
    }
    Err(last)
}

async fn detect_layout(
    demux: &mut wire::Demux,
    download: &mut wire::DownloadService,
    product_id: u32,
    files: &[ManifestFile],
) -> SliceLayout {
    let sample = files.iter().find_map(|file| {
        file.slices
            .iter()
            .map(hash_for_slice)
            .find(|hash| !hash.is_empty())
    });
    let Some(hash) = sample else {
        return SliceLayout::V3Bucket;
    };
    let candidates = [SliceLayout::V3Bucket, SliceLayout::Flat];
    let paths: Vec<String> = candidates.iter().map(|layout| slice_path(*layout, &hash)).collect();
    let Ok(urls) = sign_paths(demux, download, product_id, &paths).await else {
        return SliceLayout::V3Bucket;
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .ok();
    let Some(client) = client else {
        return SliceLayout::V3Bucket;
    };
    for (layout, url) in candidates.iter().zip(urls.iter()) {
        if client
            .get(url)
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false)
        {
            return *layout;
        }
    }
    SliceLayout::V3Bucket
}

/// Everything the installer and launcher need from the ownership row.
pub(crate) struct Prepared {
    pub manifest: Manifest,
    pub manifest_id: String,
    pub name: String,
    pub download: wire::DownloadService,
    pub layout: SliceLayout,
    pub exe: String,
    pub working_dir: String,
    pub launch_args: String,
    pub install_reg: String,
    pub uplay_id: u32,
    pub ticket: String,
}

/// Fetch the product row and its manifest, and keep the download-service
/// session that signed the manifest so the caller can reuse it for slices.
pub(crate) async fn prepare(
    demux: &mut wire::Demux,
    product_id: u32,
) -> Result<Prepared, String> {
    let owned = demux.owned_games().await?;
    let game = owned
        .into_iter()
        .find(|game| game.product_id == product_id && game.owned)
        .ok_or_else(|| format!("product {product_id} is not in the owned library"))?;
    let spec = ubisoft::launch_spec(&game.configuration);
    let install_reg = spec.install_reg;
    let uplay_id = game.uplay_id;
    let name = ubisoft::game_name(&game.configuration).unwrap_or_else(|| product_id.to_string());
    let manifest_id = if game.latest_manifest.is_empty() {
        demux
            .latest_manifests(&[product_id])
            .await?
            .remove(&product_id)
            .ok_or_else(|| {
                format!(
                    "product {product_id} has no Ubisoft CDN build (Steam-linked or delisted)"
                )
            })?
    } else {
        game.latest_manifest
    };

    let token = demux.ownership_token(product_id).await?;
    let mut download = demux.download_service(&token).await?;
    let manifest_path = format!("manifests/{manifest_id}.manifest");
    let urls = sign_paths(demux, &mut download, product_id, &[manifest_path]).await?;
    let url = urls
        .first()
        .ok_or_else(|| "Ubisoft signed no manifest URL".to_string())?;
    let manifest = manifest::fetch_manifest(url).await?;
    let exe = resolve_executable(&manifest, &spec.exe);
    let layout = detect_layout(demux, &mut download, product_id, &manifest.files).await;
    let ticket = if uplay_id != 0 {
        demux
            .uplay_ticket(uplay_id)
            .await
            .unwrap_or_default()
            .unwrap_or_default()
    } else {
        String::new()
    };
    Ok(Prepared {
        manifest,
        manifest_id,
        name,
        download,
        layout,
        exe,
        working_dir: spec.working_dir,
        launch_args: spec.arguments,
        install_reg,
        uplay_id,
        ticket,
    })
}

/// Fetch the manifest and return a frontend-friendly summary.
pub(crate) async fn probe_plan(
    demux: &mut wire::Demux,
    product_id: u32,
    install_dir: &Path,
) -> Result<InstallPlan, String> {
    let prepared = prepare(demux, product_id).await?;
    let manifest = prepared.manifest;
    Ok(InstallPlan {
        product_id,
        name: prepared.name,
        manifest: String::new(),
        install_dir: install_dir.display().to_string(),
        files: manifest.files.len(),
        slices: manifest.total_slices(),
        bytes: manifest.total_bytes(),
        compression: match manifest.compression_method {
            1 => "deflate".into(),
            3 => "zstd".into(),
            _ => "none".into(),
        },
        slice_layout: prepared.layout.label().into(),
    })
}

/// Download every file in the manifest. Existing files of the right size are
/// skipped, so a repeated call resumes an interrupted install.
pub(crate) async fn install<F>(
    demux: &mut wire::Demux,
    product_id: u32,
    install_dir: &Path,
    mut on_progress: F,
) -> Result<InstallSummary, String>
where
    F: FnMut(InstallProgress) + Send,
{
    let prepared = prepare(demux, product_id).await?;
    let Prepared {
        manifest,
        manifest_id,
        name,
        mut download,
        layout,
        exe,
        working_dir,
        launch_args,
        install_reg,
        uplay_id,
        ticket,
    } = prepared;

    let total_bytes = manifest.total_bytes();
    clear_cancel(product_id);
    let emit_step = (total_bytes / 200).max(4 * 1024 * 1024);
    let mut done_bytes = 0u64;
    let mut last_emit = 0u64;
    let mut skipped_files = 0usize;

    tokio::fs::create_dir_all(install_dir)
        .await
        .map_err(|e| format!("creating {}: {e}", install_dir.display()))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("building the CDN client: {e}"))?;

    for file in &manifest.files {
        if cancelled(product_id) {
            return Err("@t:dl.cancelled".to_string());
        }
        let out_path = manifest::safe_install_path(install_dir, &file.name)?;
        if let Some(parent) = out_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("creating {}: {e}", parent.display()))?;
        }
        if file.is_dir || file.slices.is_empty() {
            if file.is_dir {
                tokio::fs::create_dir_all(&out_path)
                    .await
                    .map_err(|e| format!("creating {}: {e}", out_path.display()))?;
            } else if file.size == 0 {
                tokio::fs::File::create(&out_path)
                    .await
                    .map_err(|e| format!("creating {}: {e}", out_path.display()))?;
            }
            continue;
        }
        if let Ok(meta) = tokio::fs::metadata(&out_path).await {
            if meta.len() == file.size {
                skipped_files += 1;
                done_bytes += file.size;
                continue;
            }
        }

        let tmp_path = out_path.with_extension("efxlve-part");
        // Resume from the last whole slice in the part file. A kill during a
        // slice leaves a short tail; it is truncated so the next write starts
        // on a slice boundary.
        let mut start_index = 0usize;
        if let Ok(meta) = tokio::fs::metadata(&tmp_path).await {
            let part_size = meta.len();
            let mut prefix = 0u64;
            for (index, slice) in file.slices.iter().enumerate() {
                if prefix + u64::from(slice.size) <= part_size {
                    prefix += u64::from(slice.size);
                    start_index = index + 1;
                } else {
                    break;
                }
            }
            if prefix != part_size {
                if let Ok(handle) = tokio::fs::OpenOptions::new()
                    .write(true)
                    .open(&tmp_path)
                    .await
                {
                    let _ = handle.set_len(prefix).await;
                }
            }
            done_bytes += prefix;
        }
        let mut out = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&tmp_path)
            .await
            .map_err(|e| format!("creating {}: {e}", tmp_path.display()))?;

        // A file can be gigabytes and thousands of slices. Sign and fetch a
        // window at a time so signed URLs stay fresh and memory stays bounded.
        // A CDN edge can drop one body mid-window; re-sign the remaining slices
        // and continue instead of failing a multi-gigabyte install.
        const WINDOW: usize = 200;
        for start in (start_index..file.slices.len()).step_by(WINDOW) {
            let end = (start + WINDOW).min(file.slices.len());
            let window: &[ManifestSlice] = &file.slices[start..end];
            let mut offset = 0usize;
            let mut failures = 0u32;
            let mut retries = 0u32;
            while offset < window.len() {
                if cancelled(product_id) {
                    return Err("@t:dl.cancelled".to_string());
                }
                let remaining = &window[offset..];
                let paths: Vec<String> = remaining
                    .iter()
                    .map(|slice| slice_path(layout, &hash_for_slice(slice)))
                    .collect();
                let urls = sign_with_reconnect(
                    demux,
                    &mut download,
                    product_id,
                    &paths,
                )
                .await?;
                if urls.len() != remaining.len() {
                    return Err(format!(
                        "{}: signed {} of {} slices",
                        file.name,
                        urls.len(),
                        remaining.len()
                    ));
                }

                let file_name = file.name.clone();
                let client = client.clone();
                let method = manifest.compression_method;
                let checks: Vec<ManifestSlice> = remaining.to_vec();
                let slice_base = start + offset;
                let jobs = urls
                    .into_iter()
                    .zip(checks)
                    .enumerate()
                    .map(|(index, (url, check))| {
                        let client = client.clone();
                        let file_name = file_name.clone();
                        async move {
                            fetch_slice(
                                &client,
                                &url,
                                &check,
                                method,
                                &file_name,
                                slice_base + index,
                            )
                            .await
                        }
                    });
                let mut stream = futures::stream::iter(jobs).buffered(16);
                let mut retry = false;
                while let Some(result) = stream.next().await {
                    if cancelled(product_id) {
                        return Err("@t:dl.cancelled".to_string());
                    }
                    let bytes = match result {
                        Ok(bytes) => bytes,
                        Err(error) => {
                            failures += 1;
                            retries += 1;
                            if failures >= 4 || retries >= 12 {
                                return Err(error);
                            }
                            println!(
                                "[ubi-direct] {} slice retry {retries}: {error}",
                                file.name
                            );
                            retry = true;
                            break;
                        }
                    };
                    use tokio::io::AsyncWriteExt;
                    out.write_all(&bytes)
                        .await
                        .map_err(|e| format!("writing {}: {e}", tmp_path.display()))?;
                    done_bytes += bytes.len() as u64;
                    offset += 1;
                    // A success means the edge is healthy again; only a run of
                    // failures at the same point should abort.
                    failures = 0;
                    if done_bytes - last_emit >= emit_step {
                        last_emit = done_bytes;
                        on_progress(InstallProgress {
                            product_id,
                            done_bytes,
                            total_bytes,
                            file: file.name.clone(),
                        });
                    }
                }
                if retry {
                    tokio::time::sleep(Duration::from_millis(400 * u64::from(failures))).await;
                }
            }
        }

        let written = tokio::fs::metadata(&tmp_path)
            .await
            .map_err(|e| format!("stat {}: {e}", tmp_path.display()))?
            .len();
        if written != file.size {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(format!(
                "{}: wrote {written} bytes but the manifest says {}",
                file.name, file.size
            ));
        }
        tokio::fs::rename(&tmp_path, &out_path)
            .await
            .map_err(|e| format!("renaming {}: {e}", out_path.display()))?;
    }

    on_progress(InstallProgress {
        product_id,
        done_bytes: total_bytes,
        total_bytes,
        file: String::new(),
    });
    // Keep the manifest next to the files so a later signed-out run can verify
    // or re-adopt the install without the ownership service.
    let _ = manifest::write_local_cache(install_dir, &manifest, &manifest_id);
    let exe = if exe.is_empty() {
        pick_executable(&manifest)
    } else {
        exe
    };
    let client_launch = ubi_installs::find(product_id)
        .map(|game| game.client_launch)
        .unwrap_or(false);
    ubi_installs::save(&ubi_installs::InstalledGame {
        product_id,
        name: name.clone(),
        install_dir: install_dir.display().to_string(),
        exe,
        installed_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        install_reg,
        working_dir,
        launch_args,
        uplay_id,
        ticket,
        client_launch,
        manifest: manifest_id,
        chunk_ids: manifest.chunk_ids.clone(),
    });
    Ok(InstallSummary {
        product_id,
        name,
        install_dir: install_dir.display().to_string(),
        files: manifest.files.len(),
        bytes: total_bytes,
        skipped_files,
    })
}

/// Prefer the executable named by `start_game` in the product configuration
/// when it matches a manifest file, and fall back to the largest manifest
/// binary when the configuration names none or points elsewhere.
pub(crate) fn resolve_executable(manifest: &Manifest, configured_exe: &str) -> String {
    let wanted = configured_exe
        .trim()
        .replace('/', "\\")
        .trim_start_matches(".\\")
        .trim_matches('\\')
        .to_string();
    if !wanted.is_empty() {
        if manifest.files.is_empty() {
            return wanted;
        }
        if let Some(hit) = manifest.files.iter().find(|file| {
            !file.is_dir
                && file
                    .name
                    .replace('/', "\\")
                    .trim_matches('\\')
                    .eq_ignore_ascii_case(&wanted)
        }) {
            return hit.name.clone();
        }
        if !wanted.contains('\\') {
            let suffix = format!("\\{}", wanted.to_ascii_lowercase());
            if let Some(hit) = manifest.files.iter().find(|file| {
                !file.is_dir
                    && file
                        .name
                        .replace('/', "\\")
                        .to_ascii_lowercase()
                        .ends_with(&suffix)
            }) {
                return hit.name.clone();
            }
        }
    }
    let picked = pick_executable(manifest);
    if picked.is_empty() {
        wanted
    } else {
        picked
    }
}

/// Pick the game executable out of the manifest. The main binary is the largest
/// `.exe` that is not a redistributable, installer, crash reporter or helper.
/// A title whose launcher lives elsewhere can be pointed at by hand later.
pub(crate) fn pick_executable(manifest: &Manifest) -> String {
    const JUNK: &[&str] = &[
        "vcredist",
        "vc_redist",
        "dxsetup",
        "directx",
        "redist",
        "unins",
        "setup",
        "install",
        "crash",
        "helper",
        "uplayinstaller",
        "dotnet",
        "netfx",
        "activation",
        "cleanup",
        "addon",
        "expansion",
        "dlc",
        "episode",
    ];
    let mut best: Option<&ManifestFile> = None;
    for file in &manifest.files {
        if file.is_dir {
            continue;
        }
        let lower = file.name.to_lowercase();
        if !lower.ends_with(".exe") {
            continue;
        }
        if lower.contains("support/") || lower.contains("support\\") {
            continue;
        }
        if JUNK.iter().any(|junk| lower.contains(junk)) {
            continue;
        }
        if best.map(|current| file.size > current.size).unwrap_or(true) {
            best = Some(file);
        }
    }
    best.map(|file| file.name.clone()).unwrap_or_default()
}

/// Where a direct install lands when the caller has no preference.
pub(crate) fn default_install_dir(product_id: u32) -> PathBuf {
    crate::companion::accounts::data_dir()
        .join("ubi-games")
        .join(product_id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zstd_and_deflate_round_trip() {
        let data = b"the quick brown fox jumps over the lazy dog";
        let zstd = zstd::encode_all(&data[..], 3).unwrap();
        assert_eq!(decompress(3, &zstd).unwrap(), data);
        let mut deflate = Vec::new();
        {
            use flate2::write::ZlibEncoder;
            use std::io::Write;
            let mut encoder = ZlibEncoder::new(&mut deflate, flate2::Compression::default());
            encoder.write_all(data).unwrap();
        }
        assert_eq!(decompress(1, &deflate).unwrap(), data);
    }

    #[test]
    fn a_good_slice_passes_and_a_corrupt_one_fails() {
        let data = b"slice payload".to_vec();
        let slice = ManifestSlice {
            size: data.len() as u32,
            download_size: Some(data.len() as u32),
            download_sha1: sha1_bytes(&data),
            content_sha1: sha1_bytes(&data),
        };
        assert_eq!(
            verify_and_decompress(0, &data, &slice, "game.dat", 0).unwrap(),
            data
        );
        let mut corrupt = data.clone();
        corrupt[0] ^= 0xff;
        let error = verify_and_decompress(0, &corrupt, &slice, "game.dat", 3).unwrap_err();
        assert!(error.contains("sha1"));
    }

    fn sha1_bytes(data: &[u8]) -> Vec<u8> {
        let mut hasher = Sha1::new();
        hasher.update(data);
        hasher.finalize().to_vec()
    }

    #[test]
    fn the_picker_prefers_the_base_game_over_an_addon_binary() {
        let manifest = Manifest {
            files: vec![
                ManifestFile {
                    name: "Anno1404Addon.exe".into(),
                    size: 39_896_504,
                    ..Default::default()
                },
                ManifestFile {
                    name: "Anno1404.exe".into(),
                    size: 38_256_568,
                    ..Default::default()
                },
                ManifestFile {
                    name: "cleanup.exe".into(),
                    size: 120_760,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        assert_eq!(pick_executable(&manifest), "Anno1404.exe");
    }

    #[test]
    fn slice_paths_use_the_bucket_layout() {
        assert_eq!(
            slice_path(SliceLayout::V3Bucket, "AB"),
            "slices_v3/b/AB"
        );
        assert_eq!(slice_path(SliceLayout::Flat, "AB"), "slices/AB");
    }

    #[test]
    fn cancel_is_per_product_and_cleared_before_a_new_install() {
        cancel(424242);
        assert!(cancelled(424242));
        assert!(!cancelled(424243));
        clear_cancel(424242);
        assert!(!cancelled(424242));
    }

    #[test]
    fn resolves_configured_executable_before_size_heuristic() {
        let manifest = Manifest {
            files: vec![
                ManifestFile {
                    name: r"bin\Editor.exe".into(),
                    size: 90_000_000,
                    ..Default::default()
                },
                ManifestFile {
                    name: r"bin\Game.exe".into(),
                    size: 20_000_000,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        assert_eq!(
            resolve_executable(&manifest, "bin/game.exe"),
            r"bin\Game.exe"
        );
        assert_eq!(
            resolve_executable(&manifest, "missing.exe"),
            r"bin\Editor.exe"
        );
    }

    #[tokio::test]
    async fn fetches_and_verifies_a_slice_over_http() {
        let data = b"a real slice payload".to_vec();
        let compressed = zstd::encode_all(&data[..], 3).unwrap();
        let slice = ManifestSlice {
            size: data.len() as u32,
            download_size: Some(compressed.len() as u32),
            download_sha1: sha1_bytes(&compressed),
            content_sha1: sha1_bytes(&data),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = compressed.clone();
        let server = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0u8; 4096];
            let _ = socket.read(&mut request).await.unwrap();
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(header.as_bytes()).await.unwrap();
            socket.write_all(&body).await.unwrap();
        });
        let client = reqwest::Client::new();
        let out = fetch_slice(
            &client,
            &format!("http://{address}/slice"),
            &slice,
            3,
            "game.dat",
            0,
        )
        .await
        .expect("slice fetch");
        server.await.unwrap();
        assert_eq!(out, data);
    }
}
