//! On-disk cache for the pictures the game page paints.
//!
//! Every metadata source already caches its answers on disk (IGDB, HLTB, the
//! critic service, Wikipedia, the store specs), so a game page opens without a
//! network round trip. Images were the gap: hero art, IGDB screenshots and
//! similar-game covers were fetched from the network on every open, which is the
//! one thing a slow connection makes visible.
//!
//! This is the second version. The first handed the front end a file path and
//! let it paint through Tauri's asset protocol; that protocol (plus a prefetch
//! that ran at boot) is the prime suspect for the window closing seconds after
//! start on some machines, so it is gone. Here the picture comes back as a
//! `data:` URL instead — the same thing the screenshot gallery already does — and
//! nothing is asked for until a page wants it, while the window is idle.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

/// The largest picture worth carrying over IPC as base64: a 3 MB image becomes a
/// 4 MB string, and the game page shows a dozen of them.
const MAX_FILE_BYTES: usize = 3 * 1024 * 1024;

/// How much base64 one call may return in total, so a page with many pictures
/// cannot hand the WebView hundreds of megabytes at once.
const MAX_CALL_BYTES: u64 = 24 * 1024 * 1024;

/// The directory cap, trimmed by age after a download batch.
const MAX_DIR_BYTES: u64 = 512 * 1024 * 1024;

const MAX_URLS_PER_CALL: usize = 64;

const MAX_PARALLEL: usize = 4;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// Makes each in-flight `.part` name unique. Two requests for the same URL can
/// finish together; they must not write into one shared temp file.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CachedImage {
    pub url: String,
    /// The picture as a `data:` URL, or an empty string when it could not be
    /// cached. The page keeps the network URL for those.
    pub data_url: String,
}

fn image_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("images"))
}

/// A stable file name per URL: the hash, plus the extension the server sends.
fn cache_key(url: &str) -> String {
    let digest = Sha256::digest(url.as_bytes());
    digest.iter().take(16).map(|byte| format!("{byte:02x}")).collect()
}

/// The extension for a content type, or `None` for anything that is not an
/// image (an error page, a redirect body, a video).
fn extension_for(content_type: &str) -> Option<&'static str> {
    let value = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match value.as_str() {
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/avif" => Some("avif"),
        "image/gif" => Some("gif"),
        "image/bmp" => Some("bmp"),
        _ => None,
    }
}

/// The media type for a cached file, by the extension it landed with.
fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "image/jpeg",
    }
}

/// Finds an already cached file for this URL, whatever extension it landed with.
fn existing_file(dir: &Path, key: &str) -> Option<PathBuf> {
    for ext in ["jpg", "png", "webp", "avif", "gif", "bmp"] {
        let candidate = dir.join(format!("{key}.{ext}"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Downloads one URL into the cache. `None` means "keep using the network URL".
async fn cache_one(client: &reqwest::Client, dir: &Path, url: &str) -> Option<PathBuf> {
    let key = cache_key(url);
    if let Some(hit) = existing_file(dir, &key) {
        return Some(hit);
    }
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let extension = extension_for(content_type)?;
    // Refuse an oversized body before it is pulled into RAM; the length is not
    // always advertised, so the post-read check below stays.
    if response
        .content_length()
        .map(|length| length > MAX_FILE_BYTES as u64)
        .unwrap_or(false)
    {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    if bytes.is_empty() || bytes.len() > MAX_FILE_BYTES {
        return None;
    }
    let target = dir.join(format!("{key}.{extension}"));
    // Write beside the target in a per-request temp file and rename, so a
    // half-written file is never read and two simultaneous downloads cannot
    // truncate each other's `.part`.
    let sequence = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(
        "{key}.{extension}.{}.{sequence}.part",
        std::process::id()
    ));
    if tokio::fs::write(&tmp, &bytes).await.is_err() {
        return None;
    }
    if tokio::fs::rename(&tmp, &target).await.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
        // Another request may have won the rename on Windows; use its file.
        return existing_file(dir, &key);
    }
    Some(target)
}

/// One picture for a caller outside the game page (the achievement card): the
/// cached file on disk, downloading it first when needed.
pub(crate) async fn cache_image(app: &AppHandle, url: &str) -> Option<PathBuf> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return None;
    }
    let dir = image_dir(app)?;
    tokio::fs::create_dir_all(&dir).await.ok()?;
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .ok()?;
    cache_one(&client, &dir, url).await
}

/// Keeps the directory under the cap, oldest file first. Runs after a download
/// batch, never on a cache hit.
async fn trim_dir(dir: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let mut total = 0u64;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Ok(meta) = entry.metadata().await else { continue };
        if !meta.is_file() {
            continue;
        }
        let size = meta.len();
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        total += size;
        files.push((entry.path(), size, modified));
    }
    if total <= MAX_DIR_BYTES {
        return;
    }
    files.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in files {
        if total <= MAX_DIR_BYTES {
            break;
        }
        if tokio::fs::remove_file(&path).await.is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

/// A cached file as a `data:` URL. `None` when it grew past what is worth
/// carrying over IPC, or when it cannot be read.
fn file_to_data_url(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_FILE_BYTES {
        return None;
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{}", mime_for(path), encoded))
}

/// The pictures the page asked for, as `data:` URLs. A URL that cannot be cached
/// comes back with an empty string, and the page keeps the network URL for it.
#[tauri::command]
pub async fn cache_images(app: AppHandle, urls: Vec<String>) -> Vec<CachedImage> {
    let mut answer: Vec<CachedImage> = urls
        .iter()
        .map(|url| CachedImage {
            url: url.clone(),
            data_url: String::new(),
        })
        .collect();

    let Some(dir) = image_dir(&app) else {
        return answer;
    };
    if tokio::fs::create_dir_all(&dir).await.is_err() {
        return answer;
    }

    // Only http(s) images are worth a slot; a data: or file: URL is already local.
    let wanted: Vec<usize> = urls
        .iter()
        .enumerate()
        .filter(|(_, url)| url.starts_with("https://") || url.starts_with("http://"))
        .map(|(index, _)| index)
        .take(MAX_URLS_PER_CALL)
        .collect();
    if wanted.is_empty() {
        return answer;
    }

    let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(client) => client,
        Err(_) => return answer,
    };

    let mut downloaded = false;
    let mut carried = 0u64;
    for chunk in wanted.chunks(MAX_PARALLEL) {
        let mut tasks = Vec::new();
        for &index in chunk {
            let url = urls[index].clone();
            let dir = dir.clone();
            let client = client.clone();
            tasks.push(tokio::spawn(async move {
                let before = existing_file(&dir, &cache_key(&url)).is_some();
                let hit = cache_one(&client, &dir, &url).await;
                (index, hit, before)
            }));
        }
        for task in tasks {
            let Ok((index, hit, before)) = task.await else { continue };
            if let Some(path) = hit {
                if !before {
                    downloaded = true;
                }
                // The base64 copy is what the page actually carries; stop adding
                // to it once the call is already heavy.
                if carried < MAX_CALL_BYTES {
                    if let Some(data_url) = file_to_data_url(&path) {
                        carried += data_url.len() as u64;
                        answer[index].data_url = data_url;
                    }
                }
            }
        }
    }

    if downloaded {
        trim_dir(&dir).await;
    }
    answer
}

/// How much room the cache takes, for the settings row that manages it.
#[tauri::command]
pub async fn image_cache_size(app: AppHandle) -> u64 {
    let Some(dir) = image_dir(&app) else { return 0 };
    let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
        return 0;
    };
    let mut total = 0u64;
    while let Ok(Some(entry)) = entries.next_entry().await {
        if let Ok(meta) = entry.metadata().await {
            if meta.is_file() {
                total += meta.len();
            }
        }
    }
    total
}

/// Empties the picture cache. The next open fetches the pictures again; the
/// return value is what the directory held, for the settings row's toast.
#[tauri::command]
pub async fn clear_image_cache(app: AppHandle) -> u64 {
    let Some(dir) = image_dir(&app) else { return 0 };
    let before = image_cache_size(app).await;
    let _ = tokio::fs::remove_dir_all(&dir).await;
    before
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_is_stable_and_the_same_url_maps_to_one_name() {
        let first = cache_key("https://images.igdb.com/igdb/image/upload/t_cover_big/co1.jpg");
        let second = cache_key("https://images.igdb.com/igdb/image/upload/t_cover_big/co1.jpg");
        let other = cache_key("https://images.igdb.com/igdb/image/upload/t_cover_big/co2.jpg");
        assert_eq!(first, second);
        assert_ne!(first, other);
        assert_eq!(first.len(), 32);
    }

    #[test]
    fn only_image_content_types_get_an_extension() {
        assert_eq!(extension_for("image/jpeg"), Some("jpg"));
        assert_eq!(extension_for("image/JPEG; charset=binary"), Some("jpg"));
        assert_eq!(extension_for("image/webp"), Some("webp"));
        assert_eq!(extension_for("text/html"), None);
        assert_eq!(extension_for(""), None);
    }

    /// The page paints from these strings, so the media type has to travel with
    /// them: the WebView cannot guess it from a file name it never sees.
    #[test]
    fn a_cached_file_comes_back_as_a_data_url_with_its_media_type() {
        let dir = std::env::temp_dir().join("efxlve-image-cache-test");
        let _ = std::fs::create_dir_all(&dir);
        let png = dir.join("one.png");
        // A one-pixel PNG's header and body, small enough to be worth carrying.
        let bytes: Vec<u8> = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        std::fs::write(&png, &bytes).expect("write");

        let url = file_to_data_url(&png).expect("a data URL");
        assert!(url.starts_with("data:image/png;base64,"), "got {}", &url[..30]);
        let encoded = url.strip_prefix("data:image/png;base64,").expect("prefix");
        let decoded = base64::engine::general_purpose::STANDARD.decode(encoded).expect("decode");
        assert_eq!(decoded, bytes, "the file's own bytes");

        // A file that is not an image extension still gets a usable type, and a
        // missing file reports nothing rather than an empty picture.
        assert_eq!(mime_for(Path::new("x.jpg")), "image/jpeg");
        assert_eq!(file_to_data_url(&dir.join("missing.png")), None);
        let _ = std::fs::remove_file(&png);
    }
}
