//! FPS from ETW present events (`Microsoft-Windows-DxgKrnl`, event 184).
//!
//! The PresentMon method without hooking: count the game's kernel present
//! events per second. Event 184 is the kernel "Present" (task 107) event that
//! every present path ends with, regardless of the graphics API, so the same
//! counter covers DirectX, Vulkan and OpenGL titles.
//!
//! Windows only lets administrators, LocalSystem services, and members of the
//! "Performance Log Users" group control trace sessions. When the session
//! cannot start, `start` returns None, `available` stays false, and the UI
//! shows the one-time enable action (see `overlay_enable_fps`).

#[cfg(windows)]
mod imp {
    use ferrisetw::provider::Provider;
    use ferrisetw::schema_locator::SchemaLocator;
    use ferrisetw::trace::UserTrace;
    use ferrisetw::EventRecord;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    /// Present-event count per process id, bumped by the ETW callback.
    static COUNTS: OnceLock<Mutex<HashMap<u32, u64>>> = OnceLock::new();
    /// True while our trace session runs: FPS data is available this run.
    static RUNNING: AtomicBool = AtomicBool::new(false);

    const SESSION_NAME: &str = "EfxlveOverlayFps";

    /// True while the FPS trace session is running.
    pub fn available() -> bool {
        RUNNING.load(Ordering::Relaxed)
    }

    /// Stops a session left behind by a crash so a fresh start neither fails
    /// with ERROR_ALREADY_EXISTS nor leaks one of the limited ETW sessions.
    /// Without the required Windows permission this is a no-op.
    fn stop_stale_session() {
        use windows::core::PCWSTR;
        use windows::Win32::System::Diagnostics::Etw::{
            ControlTraceW, EVENT_TRACE_CONTROL_STOP, EVENT_TRACE_PROPERTIES, WNODE_FLAG_TRACED_GUID,
            CONTROLTRACE_HANDLE,
        };

        let name: Vec<u16> = SESSION_NAME.encode_utf16().chain(std::iter::once(0)).collect();
        let size = std::mem::size_of::<EVENT_TRACE_PROPERTIES>() + name.len() * 2;
        let mut buffer = vec![0u8; size];
        unsafe {
            let props = buffer.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES;
            (*props).Wnode.BufferSize = size as u32;
            (*props).Wnode.Flags = WNODE_FLAG_TRACED_GUID;
            (*props).LoggerNameOffset = std::mem::size_of::<EVENT_TRACE_PROPERTIES>() as u32;
            // Normally there is no session with this name; the error is ignored.
            let _ = ControlTraceW(
                CONTROLTRACE_HANDLE::default(),
                PCWSTR(name.as_ptr()),
                props,
                EVENT_TRACE_CONTROL_STOP,
            );
        }
    }

    pub struct FpsCounter {
        /// Dropping the trace stops the session.
        _trace: UserTrace,
        last: HashMap<u32, (u64, Instant)>,
    }

    impl FpsCounter {
        pub fn start() -> Option<FpsCounter> {
            stop_stale_session();

            let provider = Provider::by_name("Microsoft-Windows-DxgKrnl")
                .ok()?
                .add_callback(move |record: &EventRecord, _schema: &SchemaLocator| {
                    // Present_V1 (task "Present") is the per-frame kernel event.
                    if record.event_id() == 184 {
                        if let Ok(mut counts) = COUNTS.get_or_init(|| Mutex::new(HashMap::new())).lock()
                        {
                            *counts.entry(record.process_id()).or_insert(0) += 1;
                        }
                    }
                })
                .build();

            let trace = UserTrace::new()
                .named(SESSION_NAME.to_string())
                .enable(provider)
                .start_and_process()
                .ok()?;
            RUNNING.store(true, Ordering::SeqCst);
            // Give the session a moment before the first sample.
            std::thread::sleep(Duration::from_millis(250));
            Some(FpsCounter {
                _trace: trace,
                last: HashMap::new(),
            })
        }

        /// Presents per second since the previous call for this pid.
        fn sample(&mut self, pid: u32) -> Option<f64> {
            let now = Instant::now();
            let map = COUNTS.get_or_init(|| Mutex::new(HashMap::new()));
            let count = map.lock().ok()?.get(&pid).copied().unwrap_or(0);
            let previous = self.last.insert(pid, (count, now));
            match previous {
                Some((prev_count, prev_at)) => {
                    let seconds = now.duration_since(prev_at).as_secs_f64().max(0.2);
                    let delta = count.saturating_sub(prev_count) as f64;
                    Some(delta / seconds)
                }
                None => None,
            }
        }

        /// Presents per second summed over the game's processes. A title can
        /// present from a child process instead of the launcher's main pid.
        pub fn sample_many(&mut self, pids: &[u32]) -> Option<f64> {
            let mut total = 0.0;
            let mut any = false;
            for pid in pids {
                if let Some(value) = self.sample(*pid) {
                    total += value;
                    any = true;
                }
            }
            if any {
                Some(total)
            } else {
                None
            }
        }
    }

    impl Drop for FpsCounter {
        fn drop(&mut self) {
            RUNNING.store(false, Ordering::SeqCst);
        }
    }
}

#[cfg(windows)]
pub use imp::{available, FpsCounter};

#[cfg(not(windows))]
pub fn available() -> bool {
    false
}

#[cfg(not(windows))]
pub struct FpsCounter;

#[cfg(not(windows))]
impl FpsCounter {
    pub fn start() -> Option<FpsCounter> {
        None
    }
    pub fn sample_many(&mut self, _pids: &[u32]) -> Option<f64> {
        None
    }
}
