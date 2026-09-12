//! legendary subprocess çalıştırma katmanı.
//!
//! Sözleşme (kaynak koddan doğrulandı):
//! - JSON çıktılar **stdout**'a yazılır (`--json`).
//! - Loglar **stderr**'e gider; stderr içeriği hata göstergesi değildir.
//! - Başarı = çıkış kodu 0 + parse edilebilir stdout.
//! - Girişsiz `list` → çıkış kodu 1, stdout boş, stderr'de "No saved credentials".
//! - Büyük kütüphanelerde achievements/metadata akışı HTTP 429 yiyebilir;
//!   legendary kısmi sonucu diske yazdığı için tekrar denemek ilerler.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::de::DeserializeOwned;

use super::LegendaryError;

const CMD_TIMEOUT_SECS: u64 = 180;
/// İlk kütüphane senkronu (yüzlerce oyun) dakikalar sürebilir.
pub const LIST_TIMEOUT_SECS: u64 = 600;

/// stderr'den gösterilebilir özet: "Error" içeren satırları tercih eder,
/// yoksa son satırlara düşer (ham traceback yerine anlamlı kısım).
fn stderr_tail(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text.lines().collect();
    let mut picked: Vec<&str> = lines
        .iter()
        .filter(|l| {
            let low = l.to_lowercase();
            low.contains("error") || low.contains("exception") || low.contains("failed")
        })
        .take(3)
        .copied()
        .collect();
    if picked.is_empty() {
        picked = lines.iter().rev().take(3).copied().collect();
        picked.reverse();
    }
    let out: String = picked.join("\n").chars().take(600).collect();
    if out.trim().is_empty() {
        "bilinmeyen hata".to_string()
    } else {
        out
    }
}

/// JSON çıktı veren komutları koşturup parse eder.
pub async fn run_json<T: DeserializeOwned>(
    bin: &Path,
    args: &[&str],
) -> Result<T, LegendaryError> {
    run_json_timeout(bin, args, CMD_TIMEOUT_SECS).await
}

/// Özel zaman aşımlı JSON komut koşturma (örn. ilk kütüphane senkronu).
pub async fn run_json_timeout<T: DeserializeOwned>(
    bin: &Path,
    args: &[&str],
    timeout_secs: u64,
) -> Result<T, LegendaryError> {
    let output = run_with_timeout(bin, args, timeout_secs).await?;
    let text = String::from_utf8_lossy(&output.stdout);
    let text = text.trim();
    if text.is_empty() {
        return Err(LegendaryError::ParseError("komut boş çıktı verdi".into()));
    }
    serde_json::from_str(text).map_err(|e| LegendaryError::ParseError(e.to_string()))
}

/// JSON döndürmeyen komutlar (auth, import, logout...) için.
pub async fn run_unit(bin: &Path, args: &[&str]) -> Result<(), LegendaryError> {
    run_with_timeout(bin, args, CMD_TIMEOUT_SECS)
        .await
        .map(|_| ())
}

async fn run_with_timeout(
    bin: &Path,
    args: &[&str],
    timeout_secs: u64,
) -> Result<std::process::Output, LegendaryError> {
    let fut = tokio::process::Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(Duration::from_secs(timeout_secs), fut)
        .await
        .map_err(|_| LegendaryError::Timeout)?
        .map_err(LegendaryError::from)?;
    if output.status.success() {
        return Ok(output);
    }
    let code = output.status.code().unwrap_or(-1);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("No saved credentials") {
        return Err(LegendaryError::NotAuthenticated);
    }
    Err(LegendaryError::CommandFailed {
        exit: code,
        stderr_tail: stderr_tail(&output.stderr),
        stderr_full: stderr.into_owned(),
    })
}
