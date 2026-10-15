//! On-disk cache for the pictures the game page paints.
//!
//! Every metadata source already caches its answers on disk (IGDB, HLTB, the
//! critic service, Wikipedia, the store specs), so a game page opens without a
//! network round trip. Images were the gap: hero art, IGDB screenshots and
//! similar-game covers were fetched from the network on every open, which is
//! the one thing a slow connection makes visible.
//!
//! The front end asks for a batch of URLs once, gets the local file for each of
//! them back, and paints from `convertFileSrc` after that. Downloads are
//! bounded, files are named after the URL's hash, and the directory is trimmed
//! to a size cap by age so it cannot grow without limit.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

/// Nothing bigger than this is worth a cache slot (key art is a few hundred KB).
const MAX_FILE_BYTES: usize = 12 * 1024 * 1024;
/// The whole directory stays under this; the oldest files go first.
const MAX_DIR_BYTES: u64 = 512 * 1024 * 1024;
/// A single page never asks for more than this in one call.
const MAX_URLS_PER_CALL: usize = 64;
/// Downloads in flight at once: enough to be quick, few enough to stay polite.
const MAX_PARALLEL: usize = 4;
/// Two extra requests do not slow the page down, but a wall of them would.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedImage {
    /// The URL the page asked about.
    pub url: String,
    /// The file on disk, or an empty string when it could not be cached.
    pub path: String,
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
    let bytes = response.bytes().await.ok()?;
    if bytes.is_empty() || bytes.len() > MAX_FILE_BYTES {
        return None;
    }
    let target = dir.join(format!("{key}.{extension}"));
    // Write beside the target and rename, so a half-written file is never read.
    let tmp = dir.join(format!("{key}.{extension}.part"));
    tokio::fs::write(&tmp, &bytes).await.ok()?;
    tokio::fs::rename(&tmp, &target).await.ok()?;
    Some(target)
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

/// The images the page needs, as local files. URLs that cannot be cached come
/// back with an empty path, and the page keeps the network URL for those.
#[tauri::command]
pub async fn cache_images(app: AppHandle, urls: Vec<String>) -> Vec<CachedImage> {
    let mut answer: Vec<CachedImage> = urls
        .iter()
        .map(|url| CachedImage {
            url: url.clone(),
            path: String::new(),
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
                answer[index].path = path.to_string_lossy().to_string();
            }
        }
    }

    if downloaded {
        trim_dir(&dir).await;
    }
    answer
}

/// How much room the cache takes, for the settings row that will manage it.
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
}
