//! Captures a clean, pixel-perfect screenshot of the profile page via WebView2's CDP interface.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileClip {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileScreenshotResult {
    pub file_path: String,
    pub file_name: String,
    pub data_url: String,
}

pub fn resolve_profile_screenshots_dir(custom_dir: Option<String>) -> PathBuf {
    if let Some(d) = custom_dir.filter(|s| !s.trim().is_empty()) {
        PathBuf::from(d.trim())
    } else {
        crate::legendary::screenshots::game_screenshots_dir("Profile")
    }
}

#[cfg(windows)]
pub async fn capture_profile_screenshot_impl(
    app: tauri::AppHandle,
    clip: Option<ProfileClip>,
    target_dir: Option<String>,
    save_to_file: bool,
    include_data_url: bool,
) -> Result<ProfileScreenshotResult, String> {
    use base64::Engine;
    use tauri::Manager;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::PCWSTR;

    let view = app
        .get_webview("main")
        .or_else(|| {
            app.get_window("main")
                .and_then(|w| w.webviews().into_iter().next())
        })
        .ok_or_else(|| "Main webview not found".to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    let tx_for_webview = tx.clone();

    let params_json = if let Some(c) = clip {
        let scale = c.scale.unwrap_or(1.0).clamp(0.5, 3.0);
        format!(
            r#"{{"format":"png","fromSurface":true,"captureBeyondViewport":true,"clip":{{"x":{:.2},"y":{:.2},"width":{:.2},"height":{:.2},"scale":{:.2}}}}}"#,
            c.x.max(0.0),
            c.y.max(0.0),
            c.width.max(10.0),
            c.height.max(10.0),
            scale
        )
    } else {
        r#"{"format":"png","fromSurface":true,"captureBeyondViewport":true}"#.to_string()
    };

    let registration = view.with_webview(move |platform| {
        let controller = platform.controller();
        let core = match unsafe { controller.CoreWebView2() } {
            Ok(core) => core,
            Err(e) => {
                if let Some(sender) = tx_for_webview.lock().unwrap().take() {
                    let _ = sender.send(Err(format!("CoreWebView2 error: {e}")));
                }
                return;
            }
        };

        let tx_for_handler = tx_for_webview.clone();
        let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
            move |result: windows::core::Result<()>, text: String| {
                if let Some(sender) = tx_for_handler.lock().unwrap().take() {
                    if let Err(e) = result {
                        let _ = sender.send(Err(format!("CDP capture failed: {e}")));
                    } else {
                        let _ = sender.send(Ok(text));
                    }
                }
                Ok(())
            },
        ));

        let method: Vec<u16> = "Page.captureScreenshot\0".encode_utf16().collect();
        let params: Vec<u16> = params_json.encode_utf16().chain(std::iter::once(0)).collect();

        let call_res = unsafe {
            core.CallDevToolsProtocolMethod(
                PCWSTR(method.as_ptr()),
                PCWSTR(params.as_ptr()),
                &handler,
            )
        };
        if let Err(e) = call_res {
            if let Some(sender) = tx_for_webview.lock().unwrap().take() {
                let _ = sender.send(Err(format!("CallDevToolsProtocolMethod failed: {e}")));
            }
        }
    });

    if let Err(e) = registration {
        return Err(format!("with_webview failed: {e}"));
    }

    let raw_json = rx.await.map_err(|e| format!("Channel receive error: {e}"))??;

    #[derive(Deserialize)]
    struct CdpResponse {
        data: String,
    }

    let parsed: CdpResponse = serde_json::from_str(&raw_json)
        .map_err(|e| format!("Failed to parse CDP response: {e}"))?;

    // Decoding is only needed for the file. The clipboard path carries the
    // base64 through untouched, and a caller that asked for neither output
    // still gets a successful capture with empty fields.
    let (file_path, file_name) = if save_to_file {
        let png_bytes = base64::engine::general_purpose::STANDARD
            .decode(&parsed.data)
            .map_err(|e| format!("Base64 decode failed: {e}"))?;

        let dest_dir = resolve_profile_screenshots_dir(target_dir);
        let _ = std::fs::create_dir_all(&dest_dir);

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let file_name = format!("Profile_{timestamp}.png");
        let path = dest_dir.join(&file_name);
        std::fs::write(&path, &png_bytes).map_err(|e| e.to_string())?;
        (path.to_string_lossy().to_string(), file_name)
    } else {
        (String::new(), String::new())
    };

    let data_url = if include_data_url {
        format!("data:image/png;base64,{}", parsed.data)
    } else {
        String::new()
    };

    Ok(ProfileScreenshotResult {
        file_path,
        file_name,
        data_url,
    })
}

#[cfg(not(windows))]
pub async fn capture_profile_screenshot_impl(
    _app: tauri::AppHandle,
    _clip: Option<ProfileClip>,
    _target_dir: Option<String>,
    _save_to_file: bool,
    _include_data_url: bool,
) -> Result<ProfileScreenshotResult, String> {
    Err("Profile screenshots are currently only supported on Windows".to_string())
}

#[tauri::command]
pub async fn capture_profile_screenshot(
    app: tauri::AppHandle,
    clip: Option<ProfileClip>,
    target_dir: Option<String>,
    save_to_file: Option<bool>,
    include_data_url: Option<bool>,
) -> Result<ProfileScreenshotResult, String> {
    capture_profile_screenshot_impl(
        app,
        clip,
        target_dir,
        save_to_file.unwrap_or(true),
        include_data_url.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub fn get_profile_screenshots_dir(custom_dir: Option<String>) -> String {
    resolve_profile_screenshots_dir(custom_dir)
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
pub fn open_profile_screenshots_folder(custom_dir: Option<String>) -> Result<(), String> {
    let dir = resolve_profile_screenshots_dir(custom_dir);
    let _ = std::fs::create_dir_all(&dir);
    crate::open_in_file_manager(&dir)
}
