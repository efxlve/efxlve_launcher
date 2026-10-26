//! Suspends and resumes child WebView2 renderers.
//!
//! A page that is merely hidden keeps its renderer and timers running. WebView2
//! can park it with `TrySuspend` instead: memory stays, CPU drops, and `Resume`
//! brings the same page back without a cold boot. The controller owns the
//! visibility switch as well, so a hidden child still receives the resume call.

#[cfg(windows)]
mod imp {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_3;
    use webview2_com::TrySuspendCompletedHandler;
    use windows::core::Interface;

    /// Hides the controller and asks WebView2 to suspend the renderer. The
    /// dispatch is queued on the webview's thread; a `true` result means the
    /// request was sent, not that the suspension already finished.
    pub fn suspend(view: &tauri::Webview) -> bool {
        let result = view.with_webview(move |platform| {
            let controller = platform.controller();
            if let Err(error) = unsafe { controller.SetIsVisible(false) } {
                eprintln!("[webview-power] SetIsVisible(false) failed: {error}");
                return;
            }
            let core = match unsafe { controller.CoreWebView2() } {
                Ok(core) => core,
                Err(error) => {
                    eprintln!("[webview-power] suspend core unavailable: {error}");
                    return;
                }
            };
            let Ok(core) = core.cast::<ICoreWebView2_3>() else {
                eprintln!("[webview-power] suspend interface unavailable");
                return;
            };
            let handler = TrySuspendCompletedHandler::create(Box::new(
                move |result: windows::core::Result<()>, _succeeded: bool| {
                    if let Err(error) = result {
                        eprintln!("[webview-power] TrySuspend failed: {error}");
                    }
                    Ok(())
                },
            ));
            if let Err(error) = unsafe { core.TrySuspend(&handler) } {
                eprintln!("[webview-power] TrySuspend call failed: {error}");
            }
        });
        if let Err(error) = &result {
            eprintln!("[webview-power] suspend bridge failed: {error}");
        }
        result.is_ok()
    }

    /// Resumes a suspended renderer and makes the controller visible again.
    pub fn resume(view: &tauri::Webview) -> bool {
        let result = view.with_webview(move |platform| {
            let controller = platform.controller();
            let core = match unsafe { controller.CoreWebView2() } {
                Ok(core) => core,
                Err(error) => {
                    eprintln!("[webview-power] resume core unavailable: {error}");
                    return;
                }
            };
            let Ok(core) = core.cast::<ICoreWebView2_3>() else {
                eprintln!("[webview-power] resume interface unavailable");
                return;
            };
            if let Err(error) = unsafe { core.Resume() } {
                eprintln!("[webview-power] Resume failed: {error}");
            }
            if let Err(error) = unsafe { controller.SetIsVisible(true) } {
                eprintln!("[webview-power] SetIsVisible(true) failed: {error}");
            }
        });
        if let Err(error) = &result {
            eprintln!("[webview-power] resume bridge failed: {error}");
        }
        result.is_ok()
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn suspend(_view: &tauri::Webview) -> bool {
        false
    }

    pub fn resume(_view: &tauri::Webview) -> bool {
        false
    }
}

pub use imp::{resume, suspend};
