//! FPS from ETW present events (`Microsoft-Windows-DxgKrnl`, event 184).
//!
//! The PresentMon method without hooking: count the game's present events per
//! second. The session starts once per app run; if it cannot start (for example
//! a restricted account), callers get `None` and the UI shows "—".

#[cfg(windows)]
mod imp {
    use ferrisetw::provider::Provider;
    use ferrisetw::schema_locator::SchemaLocator;
    use ferrisetw::trace::UserTrace;
    use ferrisetw::EventRecord;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;

    /// Present-event count per process id, bumped by the ETW callback.
    static COUNTS: OnceLock<Mutex<HashMap<u32, u64>>> = OnceLock::new();
    static STARTED: AtomicBool = AtomicBool::new(false);

    /// Starts the DxgKrnl present trace once. The session lives for the app run;
    /// events only flow while games present frames.
    fn start_etw() -> bool {
        if STARTED.load(Ordering::SeqCst) {
            return true;
        }
        let Ok(builder) = Provider::by_name("Microsoft-Windows-DxgKrnl") else {
            return false;
        };
        let provider = builder
            .add_callback(move |record: &EventRecord, _schema: &SchemaLocator| {
                // Present_V1 is the per-frame present event.
                if record.event_id() == 184 {
                    if let Ok(mut counts) = COUNTS.get_or_init(|| Mutex::new(HashMap::new())).lock()
                    {
                        *counts.entry(record.process_id()).or_insert(0) += 1;
                    }
                }
            })
            .build();
        let trace = UserTrace::new()
            .named("EfxlveOverlayFps".to_string())
            .enable(provider)
            .start_and_process();
        match trace {
            Ok(trace) => {
                // The session must outlive this call; the OS reclaims it at exit.
                std::mem::forget(trace);
                STARTED.store(true, Ordering::SeqCst);
                // Give the session a moment before the first sample.
                std::thread::sleep(std::time::Duration::from_millis(250));
                true
            }
            Err(_) => false,
        }
    }

    pub struct FpsCounter {
        last: HashMap<u32, (u64, Instant)>,
    }

    impl FpsCounter {
        pub fn start() -> Option<FpsCounter> {
            if !start_etw() {
                return None;
            }
            Some(FpsCounter {
                last: HashMap::new(),
            })
        }

        /// Presents per second since the previous call for this pid.
        pub fn sample(&mut self, pid: u32) -> Option<f64> {
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
    }
}

#[cfg(windows)]
pub use imp::FpsCounter;

#[cfg(not(windows))]
pub struct FpsCounter;

#[cfg(not(windows))]
impl FpsCounter {
    pub fn start() -> Option<FpsCounter> {
        None
    }
    pub fn sample(&mut self, _pid: u32) -> Option<f64> {
        None
    }
}
