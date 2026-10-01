//! Legendary verify-game progress parsing and the verify command.

use super::prelude::*;
use tokio::io::AsyncReadExt;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyProgressPayload {
    pub id: String,
    pub current: u64,
    pub total: u64,
    pub percent: f64,
    pub speed: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyCompletePayload {
    pub id: String,
    pub success: bool,
    pub message: String,
}

pub struct ParsedVerifyProgress {
    pub current: u64,
    pub total: u64,
    pub percent: f64,
    pub speed: String,
    pub detail: String,
}

pub fn parse_verify_progress(line: &str) -> Option<ParsedVerifyProgress> {
    let clean = line.trim();
    if clean.is_empty() {
        return None;
    }

    // 1. Standart genel ilerleme: Verification progress: 97/236 (26.2%) [0.6 MiB/s]
    if let Some(idx) = clean.find("Verification progress:") {
        let sub = clean[idx + "Verification progress:".len()..].trim();
        let slash = sub.find('/')?;
        let cur: u64 = sub[..slash].trim().parse().ok()?;
        let rest = sub[slash + 1..].trim();
        let space = rest.find(' ')?;
        let total: u64 = rest[..space].trim().parse().ok()?;
        let paren_open = rest.find('(')?;
        let paren_close = rest.find("%)")?;
        let pct: f64 = rest[paren_open + 1..paren_close].trim().parse().ok()?;
        let bracket_open = rest.find('[')?;
        let bracket_close = rest.find(']')?;
        let speed = rest[bracket_open + 1..bracket_close].trim().to_string();
        return Some(ParsedVerifyProgress {
            current: cur,
            total,
            percent: pct,
            speed,
            detail: format!("{cur}/{total} (%{pct:.1})"),
        });
    }

    // 2. Large-file verify progress: => Verifying large file "path/file.ext": 58% (4873.0/8419.3 MiB) [536.4 MiB/s]
    if let Some(idx) = clean.find("Verifying large file") {
        let sub = clean[idx + "Verifying large file".len()..].trim();
        let mut filename = String::new();
        if let Some(q1) = sub.find('"') {
            if let Some(q2) = sub[q1 + 1..].find('"') {
                let path = &sub[q1 + 1..q1 + 1 + q2];
                filename = std::path::Path::new(path)
                    .file_name()
                    .and_then(|f| f.to_str())
                    .unwrap_or(path)
                    .to_string();
            }
        }
        let colon = sub.rfind(':')?;
        let after_colon = sub[colon + 1..].trim();
        let pct_idx = after_colon.find('%')?;
        let pct: f64 = after_colon[..pct_idx].trim().parse().ok()?;

        let speed = if let (Some(b1), Some(b2)) = (after_colon.find('['), after_colon.find(']')) {
            after_colon[b1 + 1..b2].trim().to_string()
        } else {
            "—".to_string()
        };

        let size_str = if let (Some(p1), Some(p2)) = (after_colon.find('('), after_colon.find(')'))
        {
            after_colon[p1 + 1..p2].trim().to_string()
        } else {
            String::new()
        };

        let detail = if !filename.is_empty() && !size_str.is_empty() {
            format!("{filename} ({size_str})")
        } else if !filename.is_empty() {
            format!("{filename} (%{pct:.0})")
        } else {
            format!("%{pct:.1}")
        };

        return Some(ParsedVerifyProgress {
            current: pct as u64,
            total: 100,
            percent: pct,
            speed,
            detail,
        });
    }

    None
}

#[tauri::command]
pub async fn epic_verify_game(app: AppHandle, app_name: String) -> Result<String, String> {
    let bin = resolve_or_err(&app)?;

    // EGL ile kurulu oyunlarda manifest eksikse otomatik .egstore'dan kopyala
    let config_dir = skip::default_config_dir();
    let installed_file = config_dir.join("installed.json");
    if let Ok(text) = std::fs::read_to_string(&installed_file) {
        if let Ok(map) =
            serde_json::from_str::<std::collections::HashMap<String, InstalledGame>>(&text)
        {
            if let Some(g) = map.get(&app_name) {
                cache::ensure_egl_manifest(
                    &config_dir,
                    &g.app_name,
                    &g.install_path,
                    &g.version,
                    &g.platform,
                );
            }
        }
    }

    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(["verify", &app_name]);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let app_h = app.clone();
    let id_stdout = app_name.clone();
    let stdout_task = tokio::spawn(async move {
        if let Some(mut pipe) = stdout {
            let mut buf = [0u8; 4096];
            let mut remainder = String::new();
            while let Ok(n) = pipe.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                remainder.push_str(&String::from_utf8_lossy(&buf[..n]));
                while let Some(pos) = remainder.find(|c| c == '\r' || c == '\n' || c == '\t') {
                    let part = remainder[..pos].to_string();
                    remainder = remainder[pos + 1..].to_string();
                    if let Some(p) = parse_verify_progress(&part) {
                        let _ = app_h.emit(
                            "verify-progress",
                            VerifyProgressPayload {
                                id: id_stdout.clone(),
                                current: p.current,
                                total: p.total,
                                percent: p.percent,
                                speed: p.speed,
                                detail: p.detail,
                            },
                        );
                    }
                }
            }
            if let Some(p) = parse_verify_progress(&remainder) {
                let _ = app_h.emit(
                    "verify-progress",
                    VerifyProgressPayload {
                        id: id_stdout.clone(),
                        current: p.current,
                        total: p.total,
                        percent: p.percent,
                        speed: p.speed,
                        detail: p.detail,
                    },
                );
            }
        }
    });

    let app_h2 = app.clone();
    let id_stderr = app_name.clone();
    let (err_tx, mut err_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let stderr_task = tokio::spawn(async move {
        if let Some(mut pipe) = stderr {
            let mut buf = [0u8; 4096];
            let mut remainder = String::new();
            while let Ok(n) = pipe.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                remainder.push_str(&String::from_utf8_lossy(&buf[..n]));
                while let Some(pos) = remainder.find(|c| c == '\r' || c == '\n' || c == '\t') {
                    let part = remainder[..pos].to_string();
                    remainder = remainder[pos + 1..].to_string();
                    if part.contains("CRITICAL:") || part.contains("ERROR:") {
                        let _ = err_tx.send(part.clone());
                    }
                    if let Some(p) = parse_verify_progress(&part) {
                        let _ = app_h2.emit(
                            "verify-progress",
                            VerifyProgressPayload {
                                id: id_stderr.clone(),
                                current: p.current,
                                total: p.total,
                                percent: p.percent,
                                speed: p.speed,
                                detail: p.detail,
                            },
                        );
                    }
                }
            }
        }
    });

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    // Critical error check (e.g. missing manifest)
    let mut critical_error: Option<String> = None;
    while let Ok(msg) = err_rx.try_recv() {
        critical_error = Some(msg);
    }

    if status.success() && critical_error.is_none() {
        let msg = "@t:verify.successDetail".to_string();
        let _ = app.emit(
            "verify-complete",
            VerifyCompletePayload {
                id: app_name.clone(),
                success: true,
                message: msg.clone(),
            },
        );
        Ok(msg)
    } else {
        let raw_err = critical_error.unwrap_or_else(|| "@t:verify.problem".to_string());
        let msg = if raw_err.contains("Manifest appears to be missing") {
            "@t:verify.manifestMissing".to_string()
        } else {
            raw_err
        };
        let _ = app.emit(
            "verify-complete",
            VerifyCompletePayload {
                id: app_name.clone(),
                success: false,
                message: msg.clone(),
            },
        );
        Err(msg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_parse_verify_progress() {
        let line1 = "Verification progress: 220/236 (84.5%) [204.2 MiB/s]";
        let res1 = parse_verify_progress(line1);
        assert!(res1.is_some());
        let p1 = res1.unwrap();
        assert_eq!(p1.current, 220);
        assert_eq!(p1.total, 236);
        assert!((p1.percent - 84.5).abs() < 0.01);
        assert_eq!(p1.speed, "204.2 MiB/s");

        let line2 = "=> Verifying large file \"archive/pc/content/audio_2_soundbanks.archive\": 58% (4873.0/8419.3 MiB) [536.4 MiB/s]";
        let res2 = parse_verify_progress(line2);
        assert!(res2.is_some());
        let p2 = res2.unwrap();
        assert_eq!(p2.percent, 58.0);
        assert_eq!(p2.speed, "536.4 MiB/s");
        assert!(p2.detail.contains("audio_2_soundbanks.archive"));
        assert!(p2.detail.contains("4873.0/8419.3 MiB"));
    }
}
