use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use tauri::{AppHandle, Emitter};

static RUNNING_GAME: RwLock<Option<(String, String)>> = RwLock::new(None);

pub fn set_active_running_game(app_name: &str, title: &str) {
    if let Ok(mut g) = RUNNING_GAME.write() {
        *g = Some((app_name.to_string(), title.to_string()));
    }
}

pub fn clear_active_running_game(app_name: &str) {
    if let Ok(mut g) = RUNNING_GAME.write() {
        if let Some((ref cur, _)) = *g {
            if cur == app_name {
                *g = None;
            }
        }
    }
}

pub fn get_active_running_game() -> Option<(String, String)> {
    RUNNING_GAME.read().ok().and_then(|g| g.clone())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameScreenshotItem {
    pub id: String,
    pub file_path: String,
    pub file_name: String,
    pub date_str: String,
    pub timestamp: u64,
    pub size_bytes: u64,
    pub size_str: String,
    pub data_url: String,
}

pub fn clean_folder_name(name: &str) -> String {
    name.replace([':', '/', '\\', '*', '?', '"', '<', '>', '|'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn get_user_pictures_dir() -> PathBuf {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        PathBuf::from(profile).join("Pictures")
    } else {
        std::env::temp_dir()
    }
}

pub fn get_user_videos_dir() -> PathBuf {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        PathBuf::from(profile).join("Videos")
    } else {
        std::env::temp_dir()
    }
}

pub fn game_screenshots_dir(clean_title: &str) -> PathBuf {
    get_user_pictures_dir()
        .join("Efxlve Screenshots")
        .join(clean_title)
}

fn format_bytes(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    } else {
        format!("{} B", bytes)
    }
}

fn file_to_data_url(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/png",
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{mime};base64,{encoded}"))
}

fn parse_file_to_item(path: &Path) -> Option<GameScreenshotItem> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "bmp") {
        return None;
    }

    let file_name = path.file_name()?.to_string_lossy().to_string();
    let size_bytes = metadata.len();
    let size_str = format_bytes(size_bytes);

    let modified = metadata.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    let duration = modified.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let timestamp = duration.as_secs();

    // Basit ve temiz tarih formatı
    let datetime = chrono_fallback(timestamp);
    let data_url = file_to_data_url(path)?;

    Some(GameScreenshotItem {
        id: format!("{}_{}", file_name, timestamp),
        file_path: path.to_string_lossy().to_string(),
        file_name,
        date_str: datetime,
        timestamp,
        size_bytes,
        size_str,
        data_url,
    })
}

fn chrono_fallback(epoch_sec: u64) -> String {
    // Harici chrono bağımlılığı yerine hafif yerel zaman formatı
    // Windows dosya zamanı veya standart tarih
    let days_since_epoch = epoch_sec / 86400;
    let day_sec = epoch_sec % 86400;
    let hours = (day_sec / 3600) % 24;
    let minutes = (day_sec / 60) % 60;
    let seconds = day_sec % 60;

    // Yaklaşık takvim tarihi
    let mut year = 1970;
    let mut days_left = days_since_epoch;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
        let days_in_year = if leap { 366 } else { 365 };
        if days_left < days_in_year {
            break;
        }
        days_left -= days_in_year;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1;
    for &d in &month_days {
        if days_left < d {
            break;
        }
        days_left -= d;
        month += 1;
    }
    let day = days_left + 1;
    format!("{:02}.{:02}.{} {:02}:{:02}:{:02}", day, month, year, hours, minutes, seconds)
}

/// Oyunun tüm ekran görüntülerini diskten tarar ve döndürür.
#[tauri::command]
pub async fn epic_get_game_screenshots(
    _app: AppHandle,
    app_name: String,
    title: String,
) -> Result<Vec<GameScreenshotItem>, String> {
    tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();
        let clean_t = clean_folder_name(&title);
        let clean_app = clean_folder_name(&app_name);

        let mut scanned_paths = std::collections::HashSet::new();

        // 1. Dedicated Efxlve Screenshots klasörleri: %USERPROFILE%\Pictures\Efxlve Screenshots\<clean_t>
        let dirs_to_check = vec![
            game_screenshots_dir(&clean_t),
            game_screenshots_dir(&clean_app),
            get_user_pictures_dir().join(&clean_t),
        ];

        for dir in dirs_to_check {
            if dir.is_dir() {
                if let Ok(entries) = std::fs::read_dir(dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if scanned_paths.insert(path.clone()) {
                            if let Some(item) = parse_file_to_item(&path) {
                                results.push(item);
                            }
                        }
                    }
                }
            }
        }

        // 2. Windows Game Bar / Captures klasörü: %USERPROFILE%\Videos\Captures
        let captures_dir = get_user_videos_dir().join("Captures");
        if captures_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&captures_dir) {
                let lower_title = clean_t.to_lowercase();
                let lower_app = clean_app.to_lowercase();
                for entry in entries.flatten() {
                    let path = entry.path();
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
                    // Dosya adı oyun başlığını veya app_name'i içeriyorsa eşle
                    if (name.contains(&lower_title) || (!lower_app.is_empty() && name.contains(&lower_app)))
                        && scanned_paths.insert(path.clone())
                    {
                        if let Some(item) = parse_file_to_item(&path) {
                            results.push(item);
                        }
                    }
                }
            }
        }

        // En yeniden en eskiye sırala
        results.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Senkron olarak birincil ekranın görüntüsünü alır ve ilgili oyun klasörüne kaydeder.
pub fn capture_game_screenshot_sync(app_name: &str, title: &str) -> Result<GameScreenshotItem, String> {
    let clean_t = if !title.trim().is_empty() {
        clean_folder_name(title)
    } else {
        clean_folder_name(app_name)
    };
    let target_dir = game_screenshots_dir(&clean_t);
    let _ = std::fs::create_dir_all(&target_dir);

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let file_name = format!("{}_Screenshot_{}.png", clean_t.replace(' ', "_"), timestamp);
    let target_file = target_dir.join(&file_name);

    let target_str = target_file.to_string_lossy().to_string();

    // PowerShell -EncodedCommand ile ekran görüntüsü yakalama
    let ps_code = format!(
        r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('{}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
"#,
        target_str.replace('\'', "''")
    );

    let utf16_bytes: Vec<u8> = ps_code.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let encoded_cmd = base64::engine::general_purpose::STANDARD.encode(&utf16_bytes);

    let status = std::process::Command::new("powershell.exe")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-EncodedCommand")
        .arg(&encoded_cmd)
        .status();

    match status {
        Ok(s) if s.success() && target_file.exists() => {
            parse_file_to_item(&target_file).ok_or_else(|| "Ekran görüntüsü dosyası okunamadı".to_string())
        }
        Ok(s) => Err(format!("Ekran görüntüsü alınamadı (kod: {:?})", s.code())),
        Err(e) => Err(format!("PowerShell çalıştırılamadı: {}", e)),
    }
}

/// Ekran görüntüsü alır ve oyunun klasörüne kaydeder.
#[tauri::command]
pub async fn epic_capture_game_screenshot(
    _app: AppHandle,
    app_name: String,
    title: String,
) -> Result<GameScreenshotItem, String> {
    tokio::task::spawn_blocking(move || {
        capture_game_screenshot_sync(&app_name, &title)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Oyun açıkken F12 tuşuna basıldığında ekran görüntüsü yakalayan arka plan dinleyicisi.
#[cfg(target_os = "windows")]
pub fn start_f12_listener(app: AppHandle) {
    std::thread::spawn(move || {
        #[link(name = "user32")]
        extern "system" {
            fn GetAsyncKeyState(vKey: i32) -> i16;
        }

        const VK_F12: i32 = 0x7B;
        let mut was_down = false;
        let mut last_capture_time = std::time::Instant::now() - std::time::Duration::from_secs(10);

        loop {
            std::thread::sleep(std::time::Duration::from_millis(35));

            // Sadece bir oyun aktif oynanıyorken F12'yi kontrol et
            let running = get_active_running_game();
            if running.is_none() {
                was_down = false;
                continue;
            }

            let state = unsafe { GetAsyncKeyState(VK_F12) };
            let is_down = (state as u16 & 0x8000) != 0;

            if is_down && !was_down {
                // F12 tuşuna basıldı! (Key Down Edge)
                if last_capture_time.elapsed() >= std::time::Duration::from_millis(600) {
                    last_capture_time = std::time::Instant::now();
                    if let Some((app_name, title)) = running {
                        let app_clone = app.clone();
                        let app_name_clone = app_name.clone();
                        let title_clone = title.clone();
                        std::thread::spawn(move || {
                            if let Ok(item) = capture_game_screenshot_sync(&app_name_clone, &title_clone) {
                                let _ = app_clone.emit(
                                    "screenshot-captured",
                                    serde_json::json!({
                                        "id": app_name_clone,
                                        "title": title_clone,
                                        "item": item,
                                    }),
                                );
                            }
                        });
                    }
                }
            }

            was_down = is_down;
        }
    });
}

#[cfg(not(target_os = "windows"))]
pub fn start_f12_listener(_app: AppHandle) {}

/// Ekran görüntüsü dosyasını siler.
#[tauri::command]
pub async fn epic_delete_game_screenshot(_app: AppHandle, file_path: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let p = Path::new(&file_path);
        if p.exists() && p.is_file() {
            std::fs::remove_file(p).map(|_| true).map_err(|e| e.to_string())
        } else {
            Err("Dosya bulunamadı".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Oyunun ekran görüntüleri klasörünü Windows Explorer ile açar.
#[tauri::command]
pub async fn epic_open_game_screenshots_folder(
    _app: AppHandle,
    app_name: String,
    title: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let clean_t = if !title.trim().is_empty() {
            clean_folder_name(&title)
        } else {
            clean_folder_name(&app_name)
        };
        let target_dir = game_screenshots_dir(&clean_t);
        let _ = std::fs::create_dir_all(&target_dir);

        // Kural 10: Klasör açma = Rust'tan explorer
        let _ = std::process::Command::new("explorer.exe")
            .arg(&target_dir)
            .spawn();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Oyun oynanırken alınan yeni ekran görüntülerini tespit edip taşır / bağlar.
pub fn scan_new_captures_for_game(clean_title: &str, start_time: std::time::SystemTime) -> Vec<PathBuf> {
    let mut added = Vec::new();
    let target_dir = game_screenshots_dir(clean_title);
    let _ = std::fs::create_dir_all(&target_dir);

    // 1. Pictures\Screenshots kontrolü
    let pic_ss = get_user_pictures_dir().join("Screenshots");
    if pic_ss.is_dir() {
        if let Ok(entries) = std::fs::read_dir(pic_ss) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Ok(meta) = path.metadata() {
                    if meta.is_file() {
                        if let Ok(mod_time) = meta.modified() {
                            if mod_time >= start_time {
                                if let Some(name) = path.file_name() {
                                    let dest = target_dir.join(name);
                                    if !dest.exists() {
                                        if let Ok(_) = std::fs::copy(&path, &dest) {
                                            added.push(dest);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Videos\Captures kontrolü
    let vid_cap = get_user_videos_dir().join("Captures");
    if vid_cap.is_dir() {
        if let Ok(entries) = std::fs::read_dir(vid_cap) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Ok(meta) = path.metadata() {
                    if meta.is_file() {
                        if let Ok(mod_time) = meta.modified() {
                            if mod_time >= start_time {
                                if let Some(name) = path.file_name() {
                                    let dest = target_dir.join(name);
                                    if !dest.exists() {
                                        if let Ok(_) = std::fs::copy(&path, &dest) {
                                            added.push(dest);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    added
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_folder_name() {
        assert_eq!(clean_folder_name("Dead by Daylight: Special Edition"), "Dead by Daylight Special Edition");
        assert_eq!(clean_folder_name("Tom Clancy's The Division / 2"), "Tom Clancy's The Division 2");
    }

    #[test]
    fn test_chrono_fallback() {
        // 1700000000 = 14.11.2023 22:13:20
        let date_str = chrono_fallback(1700000000);
        assert!(date_str.contains("2023"));
    }

    #[test]
    fn test_running_game_lifecycle() {
        set_active_running_game("Sugar", "Alan Wake 2");
        assert_eq!(get_active_running_game(), Some(("Sugar".to_string(), "Alan Wake 2".to_string())));
        clear_active_running_game("Sugar");
        assert_eq!(get_active_running_game(), None);
    }
}
