// Release modunda Windows'ta fazladan konsol penceresi açılmasını engeller.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod legendary;

use std::{collections::HashMap, sync::Mutex, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

// camelCase: frontend (TS) ile birebir aynı isimler (sizeMb, installPath...)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Game {
    id: String,
    title: String,
    genre: String,
    /// 0 = ücretsiz, aksi halde TL fiyatı
    price: f32,
    size_mb: u64,
    version: String,
    installed: bool,
    install_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    id: String,
    progress: u8,
    done: bool,
}

struct AppState {
    games: Mutex<Vec<Game>>,
}

/// Mağaza kataloğu (demo verisi). Gerçek projede burası bir API'den beslenir.
fn default_catalog() -> Vec<Game> {
    vec![
        Game { id: "anadolu-efsaneleri".into(), title: "Anadolu Efsaneleri".into(), genre: "RPG".into(), price: 0.0, size_mb: 4200, version: "1.4.2".into(), installed: false, install_path: None },
        Game { id: "neon-surucu".into(), title: "Neon Sürücü".into(), genre: "Yarış".into(), price: 249.0, size_mb: 8100, version: "2.0.1".into(), installed: false, install_path: None },
        Game { id: "uzay-madencisi".into(), title: "Uzay Madencisi".into(), genre: "Simülasyon".into(), price: 149.0, size_mb: 2300, version: "0.9.7".into(), installed: false, install_path: None },
        Game { id: "kale-kusatmasi".into(), title: "Kale Kuşatması".into(), genre: "Strateji".into(), price: 399.0, size_mb: 12500, version: "3.2.0".into(), installed: false, install_path: None },
        Game { id: "piksel-ciftligi".into(), title: "Piksel Çiftliği".into(), genre: "Bağımsız".into(), price: 99.0, size_mb: 900, version: "1.1.0".into(), installed: false, install_path: None },
        Game { id: "derin-dehlizler".into(), title: "Derin Dehlizler".into(), genre: "Roguelike".into(), price: 0.0, size_mb: 1600, version: "1.0.5".into(), installed: false, install_path: None },
    ]
}

/// Kurulu oyunların tutulduğu dosya: <app_data>/library.json
fn library_file(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("library.json")
}

/// id -> kurulum klasörü eşleşmesi
fn load_library(app: &AppHandle) -> HashMap<String, String> {
    std::fs::read_to_string(library_file(app))
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

fn save_library(app: &AppHandle, lib: &HashMap<String, String>) {
    let path = library_file(app);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(data) = serde_json::to_string_pretty(lib) {
        let _ = std::fs::write(path, data);
    }
}

/// Epic/Legendary ayarları (`<app_data>/settings.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EpicSettings {
    pub alt_legendary_bin: Option<String>,
}

fn settings_file(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("settings.json")
}

pub fn load_settings(app: &AppHandle) -> EpicSettings {
    std::fs::read_to_string(settings_file(app))
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

pub fn save_settings(app: &AppHandle, s: &EpicSettings) {
    let path = settings_file(app);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(data) = serde_json::to_string_pretty(s) {
        let _ = std::fs::write(path, data);
    }
}

#[tauri::command]
fn list_games(state: State<'_, AppState>) -> Vec<Game> {
    state.games.lock().map(|g| g.clone()).unwrap_or_default()
}

#[tauri::command]
fn library_dir(app: AppHandle) -> String {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "bilinmiyor".into())
}

/// Epic Mağaza'yı ANA pencerenin içinde gömülü webview olarak gösterir.
/// Gerekçe: Epic `X-Frame-Options: SAMEORIGIN` gönderdiği için iframe ile
/// gömülemez; bu yüzden içerik alanına native bir child webview konur
/// (`unstable` özelliğindeki `add_child` API'si ile).
/// Üst bar HTML olarak üstte kalır, sekmeler çalışmaya devam eder.
///
/// NOT: child webview'un konumu sonradan değiştirilemediğinden, pencere
/// yeniden boyutlandırıldığında `recreate=true` ile yeniden kurulur
/// (etiket sayacı çakışmayı önler, eskiler arka planda kapanır).
static STORE_VIEW_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn store_views(window: &tauri::Window) -> Vec<tauri::Webview> {
    window
        .webviews()
        .into_iter()
        .filter(|w| w.label().starts_with("epic-store-view"))
        .collect()
}

#[tauri::command]
async fn show_store_view(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    url: String,
    recreate: bool,
) -> Result<String, String> {
    use tauri::{LogicalPosition, LogicalSize, Position, Size, WebviewBuilder, WebviewUrl};
    eprintln!("[store-view] show url={url} recreate={recreate}");
    let parsed: url::Url = url.parse().map_err(|_| "adres geçersiz".to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("yalnızca http(s) adresleri açılabilir".to_string()),
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "ana pencere bulunamadı".to_string())?;
    if !recreate {
        if let Some(v) = store_views(&window).into_iter().next() {
            v.navigate(parsed).map_err(|e| e.to_string())?;
            v.show().map_err(|e| e.to_string())?;
            return Ok("odaklandı".into());
        }
    } else {
        for v in store_views(&window) {
            let _ = v.close();
        }
    }
    let seq = STORE_VIEW_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let builder = WebviewBuilder::new(
        format!("epic-store-view-{seq}"),
        WebviewUrl::External(parsed),
    );
    let pos = Position::Logical(LogicalPosition::new(x, y));
    let size = Size::Logical(LogicalSize::new(width.max(100.0), height.max(100.0)));
    // add_child ana thread'e iş postalar ve bitmesini bekler; olası takılmada
    // arayüzün kilitlenmemesi için ayrı thread + zaman aşımı ile koşturulur.
    let handle = tokio::task::spawn_blocking(move || window.add_child(builder, pos, size));
    match tokio::time::timeout(std::time::Duration::from_secs(20), handle).await {
        Ok(Ok(Ok(_))) => {
            eprintln!("[store-view] child oluşturuldu");
            Ok("açıldı".into())
        }
        Ok(Ok(Err(e))) => {
            eprintln!("[store-view] add_child hatası: {e}");
            Err(e.to_string())
        }
        Ok(Err(join_err)) => {
            eprintln!("[store-view] thread hatası: {join_err}");
            Err("mağaza görünümü oluşturulamadı".into())
        }
        Err(_) => {
            eprintln!("[store-view] ZAMAN AŞIMI (20 sn)");
            Err("mağaza görünümü 20 sn içinde açılamadı".into())
        }
    }
}

/// Gömülü mağaza görünümünü gizler (durumu korunur).
#[tauri::command]
fn hide_store_view(app: AppHandle) -> Result<String, String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "ana pencere bulunamadı".to_string())?;
    for v in store_views(&window) {
        v.hide().map_err(|e| e.to_string())?;
    }
    Ok("gizlendi".into())
}

/// Demo kurulum: ilerlemeyi "download-progress" event'i ile yayınlar.
#[tauri::command]
fn install_game(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<String, String> {
    {
        let games = state.games.lock().map_err(|e| e.to_string())?;
        let game = games.iter().find(|g| g.id == id).ok_or("Oyun bulunamadı")?;
        if game.installed {
            return Err("Oyun zaten kurulu".into());
        }
    }

    let steps: u32 = 20;
    for i in 1..=steps {
        std::thread::sleep(Duration::from_millis(120));
        let _ = app.emit(
            "download-progress",
            InstallProgress { id: id.clone(), progress: (i * 100 / steps) as u8, done: false },
        );
    }

    let title = {
        let mut games = state.games.lock().map_err(|e| e.to_string())?;
        let game = games.iter_mut().find(|g| g.id == id).ok_or("Oyun bulunamadı")?;
        let dir = library_file(&app);
        let base = dir.parent().map(|p| p.to_path_buf()).unwrap_or_else(std::env::temp_dir);
        let install_dir = base.join("games").join(&game.id);
        let _ = std::fs::create_dir_all(&install_dir);
        game.installed = true;
        game.install_path = Some(install_dir.to_string_lossy().to_string());
        game.title.clone()
    };

    let mut lib = load_library(&app);
    let path = state
        .games
        .lock()
        .map_err(|e| e.to_string())?
        .iter()
        .find(|g| g.id == id)
        .and_then(|g| g.install_path.clone())
        .unwrap_or_default();
    lib.insert(id.clone(), path);
    save_library(&app, &lib);

    let _ = app.emit("download-progress", InstallProgress { id, progress: 100, done: true });
    Ok(format!("{title} kuruldu"))
}

#[tauri::command]
fn launch_game(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let games = state.games.lock().map_err(|e| e.to_string())?;
    let game = games.iter().find(|g| g.id == id).ok_or("Oyun bulunamadı")?;
    if !game.installed {
        return Err("Oyun kurulu değil, önce yükleyin".into());
    }
    // Gerçek bir exe varsa çalıştır, yoksa demo modunda simüle et.
    if let Some(path) = &game.install_path {
        let exe = std::path::Path::new(path).join(format!("{}.exe", game.id));
        if exe.exists() {
            std::process::Command::new(&exe).spawn().map_err(|e| e.to_string())?;
            return Ok(format!("{} başlatıldı", game.title));
        }
    }
    Ok(format!("{} başlatılıyor… (demo modu)", game.title))
}

#[tauri::command]
fn uninstall_game(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<String, String> {
    let title = {
        let mut games = state.games.lock().map_err(|e| e.to_string())?;
        let game = games.iter_mut().find(|g| g.id == id).ok_or("Oyun bulunamadı")?;
        if !game.installed {
            return Err("Oyun zaten kurulu değil".into());
        }
        if let Some(path) = game.install_path.take() {
            let _ = std::fs::remove_dir_all(path);
        }
        game.installed = false;
        game.title.clone()
    };
    let mut lib = load_library(&app);
    lib.remove(&id);
    save_library(&app, &lib);
    Ok(format!("{title} kaldırıldı"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { games: Mutex::new(default_catalog()) })
        .setup(|app| {
            // Önceki kurulumları geri yükle
            let lib = load_library(app.handle());
            if !lib.is_empty() {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut games) = state.games.lock() {
                        for game in games.iter_mut() {
                            if let Some(path) = lib.get(&game.id) {
                                game.installed = true;
                                game.install_path = Some(path.clone());
                            }
                        }
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_games,
            library_dir,
            install_game,
            launch_game,
            uninstall_game,
            legendary::commands::epic_setup_status,
            legendary::commands::epic_ensure_binary,
            legendary::commands::epic_status,
            legendary::commands::epic_list_games,
            legendary::commands::epic_list_installed,
            legendary::commands::epic_list_skipped,
            legendary::commands::epic_cached_library,
            legendary::commands::epic_login_with_code,
            legendary::commands::epic_import_egl,
            legendary::commands::epic_logout,
            legendary::commands::epic_get_settings,
            legendary::commands::epic_set_alt_bin,
            show_store_view,
            hide_store_view
        ])
        .run(tauri::generate_context!())
        .expect("Tauri uygulaması çalıştırılamadı");
}
