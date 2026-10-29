//! Suspends and resumes child WebView2 renderers.
//!
//! A page that is merely hidden keeps its renderer and timers running. WebView2
//! can park it with `TrySuspend` instead: memory stays, CPU drops, and `Resume`
//! brings the same page back without a cold boot. The controller owns the
//! visibility switch as well, so a hidden child still receives the resume call.

#[cfg(windows)]
mod imp {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, ICoreWebView2_3, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
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
            let Ok(core3) = core.cast::<ICoreWebView2_3>() else {
                eprintln!("[webview-power] suspend interface unavailable");
                return;
            };
            if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
                let _ = unsafe {
                    core19.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW)
                };
            }
            let handler = TrySuspendCompletedHandler::create(Box::new(
                move |result: windows::core::Result<()>, succeeded: bool| {
                    if let Err(error) = result {
                        eprintln!("[webview-power] TrySuspend failed: {error}");
                    } else if !succeeded {
                        eprintln!("[webview-power] TrySuspend did not complete");
                    }
                    Ok(())
                },
            ));
            if let Err(error) = unsafe { core3.TrySuspend(&handler) } {
                eprintln!("[webview-power] TrySuspend call failed: {error}");
            }
        });
        if let Err(error) = &result {
            eprintln!("[webview-power] suspend bridge failed: {error}");
        }
        result.is_ok()
    }

    /// Lowers the renderer's memory target without hiding or suspending it.
    /// Safe for the main shell controller: no page reload and no timer pause.
    pub fn lower_memory(view: &tauri::Webview) -> bool {
        let result = view.with_webview(move |platform| {
            let controller = platform.controller();
            let core = match unsafe { controller.CoreWebView2() } {
                Ok(core) => core,
                Err(error) => {
                    eprintln!("[webview-power] memory core unavailable: {error}");
                    return;
                }
            };
            if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
                let _ = unsafe {
                    core19.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW)
                };
            }
        });
        if let Err(error) = &result {
            eprintln!("[webview-power] lower memory bridge failed: {error}");
        }
        result.is_ok()
    }

    /// Restores the renderer's normal memory target.
    pub fn normal_memory(view: &tauri::Webview) -> bool {
        let result = view.with_webview(move |platform| {
            let controller = platform.controller();
            let core = match unsafe { controller.CoreWebView2() } {
                Ok(core) => core,
                Err(error) => {
                    eprintln!("[webview-power] memory core unavailable: {error}");
                    return;
                }
            };
            if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
                let _ = unsafe {
                    core19.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL)
                };
            }
        });
        if let Err(error) = &result {
            eprintln!("[webview-power] restore memory bridge failed: {error}");
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
            let Ok(core3) = core.cast::<ICoreWebView2_3>() else {
                eprintln!("[webview-power] resume interface unavailable");
                return;
            };
            if let Err(error) = unsafe { core3.Resume() } {
                eprintln!("[webview-power] Resume failed: {error}");
            }
            if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
                let _ = unsafe {
                    core19.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL)
                };
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

    pub fn lower_memory(_view: &tauri::Webview) -> bool {
        false
    }

    pub fn normal_memory(_view: &tauri::Webview) -> bool {
        false
    }
}

pub use imp::{lower_memory, normal_memory, resume, suspend};
