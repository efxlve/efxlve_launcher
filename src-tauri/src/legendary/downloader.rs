//! legendary oto-indirme: yoksa GitHub releases'ten indir, `-V` ile doğrula.
//!
//! İlerleme `legendary-setup` event'iyle frontend'e akıtılır:
//! `{ state: "downloading" | "ready" | "error", progress, message }`.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::{paths, LegendaryError};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupEvent {
    state: String,
    progress: Option<u8>,
    message: String,
}

fn emit(app: &AppHandle, state: &str, progress: Option<u8>, message: String) {
    let _ = app.emit(
        "legendary-setup",
        SetupEvent {
            state: state.into(),
            progress,
            message,
        },
    );
}

/// `legendary -V` çıktısından sürümü çözer (`legendary version "0.21.1", ...`).
pub async fn binary_version(bin: &Path) -> Result<String, LegendaryError> {
    let out = tokio::process::Command::new(bin)
        .arg("-V")
        .stdin(std::process::Stdio::null())
        .output()
        .await?;
    if !out.status.success() {
        return Err(LegendaryError::DownloadFailed("binary çalışmıyor".into()));
    }
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let mut parts = text.split('"');
    parts.next();
    parts
        .next()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| LegendaryError::ParseError("sürüm okunamadı".into()))
}

/// `/releases/latest` yönlendirmesini takip edip etiket adını döndürür.
async fn latest_tag() -> Result<String, LegendaryError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| LegendaryError::DownloadFailed(e.to_string()))?;
    let resp = client
        .get(paths::RELEASES_LATEST_URL)
        .send()
        .await
        .map_err(|e| LegendaryError::DownloadFailed(e.to_string()))?;
    let url = resp.url().clone();
    url.path_segments()
        .and_then(|mut s| s.next_back())
        .map(|s| s.to_string())
        .ok_or_else(|| LegendaryError::DownloadFailed("sürüm bulunamadı".into()))
}

/// Binary hazırsa yolunu döndürür, yoksa indirir. Uzun sürebilir.
pub async fn ensure_binary(
    app: &AppHandle,
    override_path: Option<String>,
) -> Result<PathBuf, LegendaryError> {
    if let Some(o) = override_path.as_deref() {
        let p = PathBuf::from(o);
        if p.is_file() {
            binary_version(&p)
                .await
                .map_err(|_| LegendaryError::DownloadFailed("alternatif legendary çalıştırılamadı".into()))?;
            return Ok(p);
        }
    }

    let target = paths::downloaded_binary(app);
    if target.is_file() {
        if binary_version(&target).await.is_ok() {
            return Ok(target);
        }
        // Bozuk dosya: silip yeniden indir.
        let _ = tokio::fs::remove_file(&target).await;
    }

    emit(app, "downloading", Some(0), "Sürüm bilgisi alınıyor...".into());
    let tag = latest_tag().await?;
    let url = paths::download_url_for_tag(&tag);
    let dir = paths::bin_dir(app);
    tokio::fs::create_dir_all(&dir).await?;
    let part = dir.join("legendary.exe.part");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| LegendaryError::DownloadFailed(e.to_string()))?;
    let mut resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| LegendaryError::DownloadFailed(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(LegendaryError::DownloadFailed(format!("HTTP {}", resp.status())));
    }
    let total = resp.content_length();
    let mut file = tokio::fs::File::create(&part).await?;
    {
        use tokio::io::AsyncWriteExt;
        let mut done: u64 = 0;
        let mut last = 0u8;
        loop {
            match resp.chunk().await {
                Err(e) => return Err(LegendaryError::DownloadFailed(e.to_string())),
                Ok(None) => break,
                Ok(Some(bytes)) => {
                    file.write_all(&bytes).await?;
                    done += bytes.len() as u64;
                    if let Some(t) = total.filter(|t| *t > 0) {
                        let pct = (done.saturating_mul(100) / t).min(100) as u8;
                        if pct != last {
                            last = pct;
                            emit(
                                app,
                                "downloading",
                                Some(pct),
                                format!("legendary {tag} indiriliyor... %{pct}"),
                            );
                        }
                    }
                }
            }
        }
        file.flush().await?;
    }
    drop(file);
    tokio::fs::rename(&part, &target).await?;
    binary_version(&target).await?;

    emit(app, "ready", Some(100), "legendary hazır".into());
    Ok(target)
}
