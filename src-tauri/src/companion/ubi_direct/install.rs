//! Direct install from Ubisoft's CDN.
//!
//! The flow is the one YoobieRE documented and Optima proved:
//! ownership token -> download-service session -> signed URL for the manifest
//! -> signed URLs for the slices. Slices are compressed, not encrypted, and
//! carry both a compressed and a decompressed SHA-1. Files are written through
//! a `.efxlve-part` temp file so resume never trusts a half-written file.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::StreamExt;
use serde::Serialize;
use sha1::{Digest, Sha1};

use super::manifest::{self, Manifest, ManifestFile, ManifestSlice};
use super::wire;
use crate::companion::ubisoft;

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
enum SliceLayout {
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

/// Fetch the product row and its manifest, and keep the download-service
/// session that signed the manifest so the caller can reuse it for slices.
pub(crate) async fn prepare(
    demux: &mut wire::Demux,
    product_id: u32,
) -> Result<(Manifest, String, wire::DownloadService, SliceLayout), String> {
    let owned = demux.owned_games().await?;
    let game = owned
        .into_iter()
        .find(|game| game.product_id == product_id && game.owned)
        .ok_or_else(|| format!("product {product_id} is not in the owned library"))?;
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
    let layout = detect_layout(demux, &mut download, product_id, &manifest.files).await;
    Ok((manifest, name, download, layout))
}

/// Fetch the manifest and return a frontend-friendly summary.
pub(crate) async fn probe_plan(
    demux: &mut wire::Demux,
    product_id: u32,
    install_dir: &Path,
) -> Result<InstallPlan, String> {
    let (manifest, name, _download, layout) = prepare(demux, product_id).await?;
    Ok(InstallPlan {
        product_id,
        name,
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
        slice_layout: layout.label().into(),
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
    let (manifest, name, mut download, layout) = prepare(demux, product_id).await?;

    let total_bytes = manifest.total_bytes();
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
        let mut out = tokio::fs::File::create(&tmp_path)
            .await
            .map_err(|e| format!("creating {}: {e}", tmp_path.display()))?;

        // A file can be gigabytes and thousands of slices. Sign and fetch a
        // window at a time so signed URLs stay fresh and memory stays bounded.
        const WINDOW: usize = 200;
        for start in (0..file.slices.len()).step_by(WINDOW) {
            let end = (start + WINDOW).min(file.slices.len());
            let window: &[ManifestSlice] = &file.slices[start..end];
            let paths: Vec<String> = window
                .iter()
                .map(|slice| slice_path(layout, &hash_for_slice(slice)))
                .collect();
            let urls = sign_paths(demux, &mut download, product_id, &paths).await?;

            let file_name = file.name.clone();
            let client = client.clone();
            let method = manifest.compression_method;
            let checks: Vec<ManifestSlice> = window.to_vec();
            let jobs = urls
                .into_iter()
                .zip(checks)
                .enumerate()
                .map(|(offset, (url, check))| {
                    let client = client.clone();
                    let file_name = file_name.clone();
                    async move {
                        let index = start + offset;
                        let mut attempt = 0;
                        loop {
                            match client.get(&url).send().await {
                                Ok(response) => match response.error_for_status() {
                                    Ok(response) => match response.bytes().await {
                                        Ok(bytes) => {
                                            match verify_and_decompress(
                                                method, &bytes, &check, &file_name, index,
                                            ) {
                                                Ok(out) => break Ok(out),
                                                Err(error) => break Err(error),
                                            }
                                        }
                                        Err(error) => {
                                            attempt += 1;
                                            if attempt >= 3 {
                                                break Err(format!(
                                                    "reading {file_name} slice {index}: {error}"
                                                ));
                                            }
                                        }
                                    },
                                    Err(error) => {
                                        attempt += 1;
                                        if attempt >= 3 {
                                            break Err(format!(
                                                "fetching {file_name} slice {index}: {error}"
                                            ));
                                        }
                                    }
                                },
                                Err(error) => {
                                    attempt += 1;
                                    if attempt >= 3 {
                                        break Err(format!(
                                            "fetching {file_name} slice {index}: {error}"
                                        ));
                                    }
                                }
                            }
                            tokio::time::sleep(Duration::from_millis(400)).await;
                        }
                    }
                });
            let mut stream = futures::stream::iter(jobs).buffered(16);
            while let Some(result) = stream.next().await {
                let bytes = result?;
                use tokio::io::AsyncWriteExt;
                out.write_all(&bytes)
                    .await
                    .map_err(|e| format!("writing {}: {e}", tmp_path.display()))?;
                done_bytes += bytes.len() as u64;
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
    Ok(InstallSummary {
        product_id,
        name,
        install_dir: install_dir.display().to_string(),
        files: manifest.files.len(),
        bytes: total_bytes,
        skipped_files,
    })
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
    fn slice_paths_use_the_bucket_layout() {
        assert_eq!(
            slice_path(SliceLayout::V3Bucket, "AB"),
            "slices_v3/b/AB"
        );
        assert_eq!(slice_path(SliceLayout::Flat, "AB"), "slices/AB");
    }
}
