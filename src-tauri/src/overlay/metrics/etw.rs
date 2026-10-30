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

/// Frame-time lows for the presents seen in the current window.
#[derive(Clone, Copy, Default)]
pub struct Lows {
    /// Average FPS of the slowest 1% of frames.
    pub low1: Option<f64>,
    /// Average FPS of the slowest 0.1% of frames.
    pub low01: Option<f64>,
}

/// Average FPS of the slowest `fraction` of frames, from frame times sorted
/// ascending. PresentMon defines the 1% low this way: the mean of the slowest
/// 1% of frame times, converted back to FPS. A percentile frame time would
/// answer a different question and read higher on a spiky run.
fn low_fps(sorted_ms: &[f32], fraction: f64) -> Option<f64> {
    if sorted_ms.is_empty() || fraction <= 0.0 {
        return None;
    }
    let fraction = fraction.min(1.0);
    let count = ((sorted_ms.len() as f64 * fraction).ceil() as usize).max(1);
    let tail = &sorted_ms[sorted_ms.len() - count..];
    let average = tail.iter().map(|ms| *ms as f64).sum::<f64>() / tail.len() as f64;
    (average > 0.0).then(|| 1000.0 / average)
}

#[cfg(windows)]
mod imp {
    use ferrisetw::provider::Provider;
    use ferrisetw::schema_locator::SchemaLocator;
    use ferrisetw::trace::UserTrace;
    use ferrisetw::EventRecord;
    use std::collections::{HashMap, VecDeque};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    /// Present-event count per process id, bumped by the ETW callback.
    static COUNTS: OnceLock<Mutex<HashMap<u32, u64>>> = OnceLock::new();
    /// Frame times per process id, filled by the same callback.
    static FRAMES: OnceLock<Mutex<HashMap<u32, FrameRing>>> = OnceLock::new();
    /// True while our trace session runs: FPS data is available this run.
    static RUNNING: AtomicBool = AtomicBool::new(false);

    const SESSION_NAME: &str = "EfxlveOverlayFps";
    /// A little over half a minute at 60 FPS: enough samples for a stable
    /// 0.1% low without keeping the whole session in memory.
    const FRAME_CAP: usize = 2048;
    /// A 1% low needs at least two seconds of frames at 60 FPS.
    const MIN_LOW1_FRAMES: usize = 120;
    /// A 0.1% low needs enough frames for its tail to mean something.
    const MIN_LOW01_FRAMES: usize = 1000;
    /// Games present from a handful of pids; anything older is a stale session.
    const MAX_TRACKED_PIDS: usize = 16;

    /// One process's recent frame times, in milliseconds. `last_ts` is the
    /// ETW timestamp of the previous present, in 100 ns units.
    #[derive(Default)]
    struct FrameRing {
        samples: VecDeque<f32>,
        last_ts: i64,
    }

    impl FrameRing {
        fn push(&mut self, timestamp: i64) {
            if self.last_ts != 0 {
                let dt_ms = (timestamp - self.last_ts) as f64 / 10_000.0;
                if (0.1..=1000.0).contains(&dt_ms) {
                    if self.samples.len() == FRAME_CAP {
                        self.samples.pop_front();
                    }
                    self.samples.push_back(dt_ms as f32);
                } else {
                    // A pause or an alt-tab is not a frame. Start a fresh
                    // window instead of reporting the gap as a hitch.
                    self.samples.clear();
                }
            }
            self.last_ts = timestamp;
        }
    }

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
            if let Ok(mut frames) = FRAMES.get_or_init(|| Mutex::new(HashMap::new())).lock() {
                frames.clear();
            }

            let provider = Provider::by_name("Microsoft-Windows-DxgKrnl")
                .ok()?
                .add_callback(move |record: &EventRecord, _schema: &SchemaLocator| {
                    // Present_V1 (task "Present") is the per-frame kernel event.
                    if record.event_id() != 184 {
                        return;
                    }
                    let pid = record.process_id();
                    if let Ok(mut counts) = COUNTS.get_or_init(|| Mutex::new(HashMap::new())).lock()
                    {
                        *counts.entry(pid).or_insert(0) += 1;
                    }
                    let timestamp = record.raw_timestamp();
                    if let Ok(mut frames) = FRAMES.get_or_init(|| Mutex::new(HashMap::new())).lock()
                    {
                        let is_new = !frames.contains_key(&pid);
                        frames.entry(pid).or_default().push(timestamp);
                        if is_new && frames.len() > MAX_TRACKED_PIDS {
                            // Drop the pid with the fewest samples: a session
                            // that changed process should not grow forever.
                            if let Some(stale) = frames
                                .iter()
                                .filter(|(tracked, _)| **tracked != pid)
                                .min_by_key(|(_, ring)| ring.samples.len())
                                .map(|(tracked, _)| *tracked)
                            {
                                frames.remove(&stale);
                            }
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

        /// Average FPS of the slowest 1% and 0.1% of frames. The render pid is
        /// the one with the most presents in the window; a helper process that
        /// presents a few frames must not define the lows.
        pub fn lows(&self, pids: &[u32]) -> super::Lows {
            let mut samples: Vec<f32> = {
                let Ok(frames) = FRAMES.get_or_init(|| Mutex::new(HashMap::new())).lock() else {
                    return super::Lows::default();
                };
                let Some(ring) = pids
                    .iter()
                    .filter_map(|pid| frames.get(pid))
                    .max_by_key(|ring| ring.samples.len())
                else {
                    return super::Lows::default();
                };
                // Copy under the lock, sort after it: the ETW callback must not
                // wait for a percentile pass.
                ring.samples.iter().copied().collect()
            };
            samples.sort_by(f32::total_cmp);
            super::Lows {
                low1: if samples.len() >= MIN_LOW1_FRAMES {
                    super::low_fps(&samples, 0.01)
                } else {
                    None
                },
                low01: if samples.len() >= MIN_LOW01_FRAMES {
                    super::low_fps(&samples, 0.001)
                } else {
                    None
                },
            }
        }
    }

    impl Drop for FpsCounter {
        fn drop(&mut self) {
            RUNNING.store(false, Ordering::SeqCst);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::FrameRing;

        #[test]
        fn a_pause_resets_the_frame_window() {
            let mut ring = FrameRing::default();
            ring.push(10_000_000); // first present: no delta yet
            assert!(ring.samples.is_empty());
            ring.push(10_166_667); // 16.6667 ms
            assert_eq!(ring.samples.len(), 1);
            ring.push(11_000_000_000); // a long gap is a pause, not a frame
            assert!(ring.samples.is_empty());
        }

        #[test]
        fn the_ring_keeps_only_its_capacity() {
            let mut ring = FrameRing::default();
            for index in 0..(super::FRAME_CAP + 10) {
                ring.push((index as i64 + 1) * 166_667);
            }
            assert_eq!(ring.samples.len(), super::FRAME_CAP);
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
    pub fn lows(&self, _pids: &[u32]) -> Lows {
        Lows::default()
    }
}

#[cfg(test)]
mod tests {
    use super::low_fps;

    #[test]
    fn lows_average_the_slowest_frames() {
        // 99 normal frames and one 100 ms hitch: the 1% tail is the hitch.
        let mut frames = vec![10.0f32; 99];
        frames.push(100.0);
        assert_eq!(low_fps(&frames, 0.01), Some(10.0));
        assert_eq!(low_fps(&frames, 0.001), Some(10.0));
    }

    #[test]
    fn a_uniform_run_reports_its_own_fps() {
        let frames = vec![16.666_668f32; 1000];
        let low = low_fps(&frames, 0.01).expect("a low");
        assert!((low - 60.0).abs() < 0.01, "got {low}");
    }

    #[test]
    fn lows_need_samples_and_ignore_zero() {
        assert_eq!(low_fps(&[], 0.01), None);
        assert_eq!(low_fps(&[0.0], 0.01), None);
        assert_eq!(low_fps(&[10.0], 0.0), None);
    }
}
