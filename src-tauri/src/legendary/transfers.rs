//! Oyun indirme/kurma: `legendary install` sarmalayıcı + kuyruk + iptal.
//!
//! Sözleşme: ilerleme mevcut `download-progress` event'iyle akar
//! (`{id, progress, done}`), hata `download-failed`, iptal
//! `download-cancelled` ile bildirilir. Aynı anda tek aktif indirme olur.
//!
//! Heroic'ten alınan desenler: `-y --skip-dlcs --skip-sdl`, MemoryError'da
//! `--max-shared-memory 5000` ile tekrar, stdout regex parse, indirme
//! başına yeni süreç (kısmi dosyalar bir sonrakinde resume edilir).
//!
//! Eşzamanlılık notu: child process monitor görevine aittir; paylaşılan
//! state'te yalnızca kısa kritik bölümler tutulur (asla await altında kilit
//! tutulmaz). İptal, PID üzerinden işletim sistemine yaptırılır.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::{cmd_error, paths};
use crate::{load_settings, AppState};

pub struct EpicDlState {
    pub active: Option<String>,
    pub pid: Option<u32>,
    pub cancelled: bool,
    pub queue: VecDeque<String>,
}

impl Default for EpicDlState {
    fn default() -> Self {
        Self {
            active: None,
            pid: None,
            cancelled: false,
            queue: VecDeque::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DlProgress {
    id: String,
    progress: u8,
    done: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DlFailed {
    id: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DlCancelled {
    id: String,
}

fn emit_progress(app: &AppHandle, id: &str, progress: u8, done: bool) {
    let _ = app.emit(
        "download-progress",
        DlProgress {
            id: id.to_string(),
            progress,
            done,
        },
    );
}

fn emit_failed(app: &AppHandle, id: &str, message: String) {
    let _ = app.emit(
        "download-failed",
        DlFailed {
            id: id.to_string(),
            message,
        },
    );
}

fn emit_cancelled(app: &AppHandle, id: &str) {
    let _ = app.emit(
        "download-cancelled",
        DlCancelled {
            id: id.to_string(),
        },
    );
}

/// Varsayılan kurulum kökü: `<home>/Games` (legendary ile aynı).
pub fn default_install_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    home.join("Games")
}

fn resolve_base(app: &AppHandle, override_dir: Option<String>) -> PathBuf {
    if let Some(p) = override_dir
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        return PathBuf::from(p);
    }
    load_settings(app)
        .install_dir
        .map(PathBuf::from)
        .unwrap_or_else(default_install_dir)
}

fn resolve_bin(app: &AppHandle) -> Result<PathBuf, String> {
    let settings = load_settings(app);
    paths::resolve_binary(app, settings.alt_legendary_bin.as_deref()).map_err(cmd_error)
}

/// `Downloaded: 123.45 MiB` / `Download size: 123.45 MiB` satırlarından MiB.
fn parse_mib_after(line: &str, key: &str) -> Option<f64> {
    let rest = line.find(key).map(|i| &line[i + key.len()..])?.trim_start();
    let num_end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == ','))?;
    if num_end == 0 {
        return None;
    }
    let num: f64 = rest[..num_end].replace(',', ".").parse().ok()?;
    let after = rest[num_end..].trim_start();
    Some(if after.starts_with("GiB") {
        num * 1024.0
    } else {
        num
    })
}

fn spawn_install(
    bin: &PathBuf,
    app_name: &str,
    base: &PathBuf,
    high_mem: bool,
) -> std::io::Result<tokio::process::Child> {
    let mut cmd = tokio::process::Command::new(bin);
    // Not: global bayraklar (-y) alta komuttan ÖNCE gelir.
    cmd.arg("-y")
        .arg("install")
        .arg(app_name)
        .arg("--base-path")
        .arg(base)
        .arg("--skip-dlcs")
        .arg("--skip-sdl")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if high_mem {
        cmd.arg("--max-shared-memory").arg("5000");
    }
    cmd.spawn()
}

/// stdout borusunu arka planda tüketir (dolu boru süreci kitler!).
/// Not: ilerleme STDOUT'ta değil STDERR'dedir; burası sadece tıkanmayı önler.
fn spawn_drain(stdout: Option<tokio::process::ChildStdout>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if let Some(o) = stdout {
            let mut r = BufReader::new(o).lines();
            while let Ok(Some(_)) = r.next_line().await {}
        }
    })
}

/// `= Progress: 50.46% (1156/2291)` satırından yüzde.
/// legendary'nin kendi hesabı en doğrusudur; MiB hesabı yedektir.
fn parse_progress_percent(line: &str) -> Option<i32> {
    let idx = line.find("Progress:")? + "Progress:".len();
    let rest = line[idx..].trim_start();
    let num_end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.'))?;
    if num_end == 0 {
        return None;
    }
    let v: f64 = rest[..num_end].parse().ok()?;
    Some((v.round() as i32).clamp(0, 100))
}

fn short_error(err_text: &str) -> String {
    let lines: Vec<&str> = err_text.lines().collect();
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

/// İndirmeyi başlatır (kilit altında çağrılmaz!). Başarıda izleme görevi kurulur.
fn start_download(app: &AppHandle, app_name: String, override_dir: Option<String>) -> Result<String, String> {
    let bin = resolve_bin(app)?;
    let base = resolve_base(app, override_dir);
    let mut child =
        spawn_install(&bin, &app_name, &base, false).map_err(|e| format!("başlatılamadı: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let pid = child.id();
    {
        let state = app.state::<AppState>();
        let mut s = state.epic_dl.lock().map_err(|e| e.to_string())?;
        if s.active.is_some() {
            // Araya başkası girdi: yetim bırakmamak için öldür (kill_on_drop yedeği).
            drop(s);
            drop(child);
            return Err("başka indirme başladı".into());
        }
        s.active = Some(app_name.clone());
        s.pid = pid;
        s.cancelled = false;
    }
    emit_progress(app, &app_name, 0, false);
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        monitor_download(app2, bin, app_name, base, child, stdout, stderr).await;
    });
    Ok("İndirme başlatıldı".into())
}

#[allow(clippy::too_many_arguments)]
async fn monitor_download(
    app: AppHandle,
    bin: PathBuf,
    app_name: String,
    base: PathBuf,
    mut child: tokio::process::Child,
    mut stdout: Option<tokio::process::ChildStdout>,
    mut stderr: Option<tokio::process::ChildStderr>,
) {
    let mut total = 0.0f64;
    let mut last_pct: i32 = -1;
    let mut high_mem = false;
    let mut tail: VecDeque<String> = VecDeque::with_capacity(60);

    let result: Result<(), String> = loop {
        // stdout ilerleme TAŞIMAZ ama boru dolmasın diye tüketilir.
        let out_task = spawn_drain(stdout.take());
        if let Some(e) = stderr.take() {
            let mut r = BufReader::new(e).lines();
            while let Ok(Some(line)) = r.next_line().await {
                if tail.len() >= 60 {
                    tail.pop_front();
                }
                // Önce legendary'nin kendi yüzdesi, yoksa MiB hesabı.
                if let Some(pct) = parse_progress_percent(&line) {
                    if pct != last_pct {
                        last_pct = pct;
                        emit_progress(&app, &app_name, pct as u8, false);
                    }
                } else {
                    if total <= 0.0 {
                        if let Some(v) = parse_mib_after(&line, "Download size:") {
                            total = v;
                        }
                    }
                    if total > 0.0 {
                        if let Some(d) = parse_mib_after(&line, "Downloaded:") {
                            let pct = ((d / total * 100.0).round() as i32).clamp(0, 100);
                            if pct != last_pct {
                                last_pct = pct;
                                emit_progress(&app, &app_name, pct as u8, false);
                            }
                        }
                    }
                }
                tail.push_back(line);
            }
        }
        let status = child.wait().await.ok();
        let _ = out_task.await;
        let err_text: String = tail.iter().cloned().collect::<Vec<_>>().join("\n");
        if status.is_some_and(|s| s.success()) {
            break Ok(());
        }
        // Heroic deseni: bellek hatasında limiti artırıp bir kez daha dene.
        if !high_mem && err_text.contains("MemoryError") {
            // İptal edildiyse tekrar başlatma.
            let cancelled = app
                .state::<AppState>()
                .epic_dl
                .lock()
                .map(|s| s.cancelled)
                .unwrap_or(false);
            if cancelled {
                break Err("İndirme iptal edildi".into());
            }
            high_mem = true;
            total = 0.0;
            last_pct = -1;
            match spawn_install(&bin, &app_name, &base, true) {
                Ok(c) => {
                    child = c;
                    stdout = child.stdout.take();
                    stderr = child.stderr.take();
                    // pid'i güncelle (iptal komutu güncel süreci bulsun)
                    if let Ok(mut s) = app.state::<AppState>().epic_dl.lock() {
                        s.pid = child.id();
                    }
                    continue;
                }
                Err(e) => {
                    break Err(format!("tekrar başlatılamadı: {e}"));
                }
            }
        }
        break Err(short_error(&err_text));
    };

    // Son durum: iptal edildiyse sessizce kuyruğa geç.
    let next = {
        let state = app.state::<AppState>();
        let mut s = match state.epic_dl.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let was_cancelled = s.cancelled;
        if s.active.as_ref().is_some_and(|a| a == &app_name) {
            s.active = None;
            s.pid = None;
        }
        if was_cancelled {
            s.cancelled = false;
            emit_cancelled(&app, &app_name);
        } else {
            match &result {
                Ok(()) => emit_progress(&app, &app_name, 100, true),
                Err(msg) => emit_failed(&app, &app_name, msg.clone()),
            }
        }
        s.queue.pop_front().map(|q| q)
    };
    if let Some(n) = next {
        if let Err(msg) = start_download(&app, n.clone(), None) {
            emit_failed(&app, &n, msg);
            pump_queue(&app);
        }
    }
}

/// Sıradaki indirmeyi başlatır (boşta ise).
fn pump_queue(app: &AppHandle) {
    let next = {
        let state = app.state::<AppState>();
        let mut s = match state.epic_dl.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if s.active.is_some() {
            return;
        }
        s.queue.pop_front()
    };
    if let Some(q) = next {
        if let Err(msg) = start_download(app, q.clone(), None) {
            emit_failed(app, &q, msg);
            pump_queue(app);
        }
    }
}

#[tauri::command]
pub async fn epic_install_game(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    app_name: String,
    install_dir: Option<String>,
) -> Result<String, String> {
    let app_name = app_name.trim().to_string();
    if app_name.is_empty() {
        return Err("oyun adı boş".into());
    }
    {
        let s = state.epic_dl.lock().map_err(|e| e.to_string())?;
        if s.active.as_ref().is_some_and(|a| a == &app_name)
            || s.queue.iter().any(|q| q == &app_name)
        {
            return Err("Bu oyun zaten indiriliyor veya kuyrukta".into());
        }
        if s.active.is_some() {
            drop(s);
            let mut s = state.epic_dl.lock().map_err(|e| e.to_string())?;
            s.queue.push_back(app_name.clone());
            drop(s);
            emit_progress(&app, &app_name, 0, false);
            return Ok("Aktif indirme var — kuyruğa alındı".into());
        }
    }
    start_download(&app, app_name, install_dir)
}

#[tauri::command]
pub async fn epic_cancel_download(app: AppHandle, app_name: String) -> Result<String, String> {
    let pid = {
        let state = app.state::<AppState>();
        let mut s = state.epic_dl.lock().map_err(|e| e.to_string())?;
        if s.active.as_ref().is_some_and(|a| a == &app_name) {
            s.cancelled = true;
            s.active = None;
            s.pid.take()
        } else if s.queue.iter().any(|q| q == &app_name) {
            s.queue.retain(|q| q != &app_name);
            drop(s);
            emit_cancelled(&app, &app_name);
            return Ok("Kuyruktan çıkarıldı".into());
        } else {
            return Err("Aktif indirme bulunamadı".into());
        }
    };
    // Pid üzerinden sonlandır (monitor görevi çıkışı iptal olarak işler).
    if let Some(pid) = pid {
        #[cfg(windows)]
        {
            let _ = tokio::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output()
                .await;
        }
        #[cfg(not(windows))]
        {
            let _ = tokio::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output()
                .await;
        }
    }
    pump_queue(&app);
    Ok("İndirme iptal edildi".into())
}

#[tauri::command]
pub async fn epic_uninstall_game(
    app: AppHandle,
    app_name: String,
    keep_files: bool,
) -> Result<String, String> {
    let bin = resolve_bin(&app)?;
    let title = app_name.clone();
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("-y").arg("uninstall");
    if keep_files {
        cmd.arg("--keep-files");
    }
    cmd.arg(&app_name)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let out = cmd.output().await.map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(format!("{title} kaldırıldı"))
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(short_error(&err))
    }
}

#[tauri::command]
pub fn epic_default_install_dir() -> String {
    default_install_dir().to_string_lossy().to_string()
}

#[tauri::command]
pub fn epic_set_install_dir(
    app: AppHandle,
    path: Option<String>,
) -> Result<crate::EpicSettings, String> {
    let mut s = load_settings(&app);
    s.install_dir = path.and_then(|p| {
        let t = p.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    crate::save_settings(&app, &s);
    Ok(s)
}

/// Oyunu başlatır: önce online (sahiplik biletiyle), olmazsa ve oyun
/// offline çalışabiliyorsa `--offline` ile tekrar dener.
/// Oyun süreci ayrık başlatılır (handle düşünce oyun yaşamaya devam eder).
/// İlk saniyelerde çökerse hata döndürür, yoksa "başlatıldı" sayar.
#[tauri::command]
pub async fn epic_launch_game(app: AppHandle, app_name: String) -> Result<String, String> {
    let bin = resolve_bin(&app)?;
    let installed: Vec<super::models::InstalledGame> =
        super::client::run_json(&bin, &["list-installed", "--json"])
            .await
            .map_err(cmd_error)?;
    if let Some(entry) = installed.iter().find(|g| g.app_name == app_name) {
        let title = if entry.title.is_empty() {
            app_name.clone()
        } else {
            entry.title.clone()
        };
        match spawn_launched(&bin, &app_name, &[]).await {
            Ok(()) => Ok(format!("{title} başlatıldı")),
            Err(first) => {
                if entry.can_run_offline {
                    spawn_launched(&bin, &app_name, &["--offline"])
                        .await
                        .map(|_| format!("{title} başlatıldı (çevrimdışı)"))
                        .map_err(|e| format!("{first}\n{e}"))
                } else {
                    Err(first)
                }
            }
        }
    } else {
        // Kurulu değil: 3. parti başlatıcı (EA App / Origin veya Ubisoft) kontrolü
        let config = super::skip::default_config_dir();
        let meta_path = config.join("metadata").join(format!("{app_name}.json"));
        if let Ok(text) = std::fs::read_to_string(&meta_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                let title = json
                    .get("app_title")
                    .and_then(|t| t.as_str())
                    .unwrap_or(&app_name)
                    .to_string();
                let lower = text.to_lowercase();
                if lower.contains("origin")
                    || lower.contains("the ea app")
                    || lower.contains("ea games")
                    || lower.contains("respawn")
                {
                    return spawn_launched(&bin, &app_name, &["--origin"])
                        .await
                        .map(|_| format!("{title} EA App üzerinden başlatıldı"));
                } else if lower.contains("ubisoftconnect") || lower.contains("ubisoft") {
                    return spawn_launched(&bin, &app_name, &["--ubisoft"])
                        .await
                        .map(|_| format!("{title} Ubisoft Connect üzerinden başlatıldı"));
                }
            }
        }
        Err("Oyun kurulu değil".to_string())
    }
}

async fn spawn_launched(bin: &PathBuf, app_name: &str, extra_args: &[&str]) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("launch").arg(app_name);
    for arg in extra_args {
        cmd.arg(arg);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    // Anında çökme kontrolü: birkaç saniye yaşayan oyun "başladı" sayılır.
    match tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await {
        Ok(Ok(st)) if st.success() => Ok(()),
        Ok(Ok(_)) => Err("oyun hemen kapandı".into()),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_progress_percent_line() {
        let line = "[DLManager] INFO: = Progress: 50.46% (1156/2291), Running for 00:00:31, ETA: 00:00:30";
        assert_eq!(parse_progress_percent(line), Some(50));
        let done = "[DLManager] INFO: = Progress: 100.00% (2291/2291), Running for 00:00:32, ETA: 00:00:00";
        assert_eq!(parse_progress_percent(done), Some(100));
        assert_eq!(parse_progress_percent("no progress here"), None);
    }

    #[test]
    fn parses_mib_lines() {
        assert_eq!(
            parse_mib_after(
                "[cli] INFO: Download size: 84.29 MiB (Compression savings: 53.9%)",
                "Download size:"
            ),
            Some(84.29)
        );
        assert_eq!(
            parse_mib_after(
                "[DLManager] INFO:  - Downloaded: 1.33 MiB, Written: 2.00 MiB",
                "Downloaded:"
            ),
            Some(1.33)
        );
        assert_eq!(parse_mib_after("nothing here", "Downloaded:"), None);
    }
}
