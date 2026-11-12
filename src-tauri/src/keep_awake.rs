//! Keeps the machine awake while a store CLI transfer runs.
//!
//! A multi-hour download that loses the machine to sleep looks like a stalled
//! transfer to every store CLI. Windows records the sleep request per thread,
//! so one worker thread owns the flag and acquire/release only send it a
//! boolean there. The guard counts overlapping transfers: Epic, GOG and Amazon
//! can run at the same time.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};

static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static REQUESTS: OnceLock<Mutex<Sender<bool>>> = OnceLock::new();

/// Keeps the system out of sleep until this guard is dropped.
pub struct AwakeGuard;

impl Drop for AwakeGuard {
    fn drop(&mut self) {
        if ACTIVE.fetch_sub(1, Ordering::SeqCst) == 1 {
            request(false);
        }
    }
}

/// Starts one sleep request. Dropping the guard releases it.
pub fn keep_awake() -> AwakeGuard {
    if ACTIVE.fetch_add(1, Ordering::SeqCst) == 0 {
        request(true);
    }
    AwakeGuard
}

fn request(active: bool) {
    let sender = REQUESTS.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<bool>();
        // The worker's only job is to keep its own execution state in step.
        let _ = std::thread::Builder::new()
            .name("keep-awake".into())
            .spawn(move || {
                while let Ok(active) = rx.recv() {
                    platform_set(active);
                }
            });
        Mutex::new(tx)
    });
    let _ = sender
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .send(active);
}

#[cfg(windows)]
fn platform_set(active: bool) {
    // Declared here so the sleep helper does not pull a new Windows crate
    // feature into the build for one call.
    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(flags: u32) -> u32;
    }
    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    let flags = if active {
        ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    } else {
        ES_CONTINUOUS
    };
    unsafe {
        SetThreadExecutionState(flags);
    }
}

/// The preview desktops keep their current power behavior.
#[cfg(not(windows))]
fn platform_set(_active: bool) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlapping_guards_release_only_on_the_last_drop() {
        let first = keep_awake();
        let second = keep_awake();
        assert_eq!(ACTIVE.load(Ordering::SeqCst), 2);
        drop(first);
        assert_eq!(ACTIVE.load(Ordering::SeqCst), 1);
        drop(second);
        assert_eq!(ACTIVE.load(Ordering::SeqCst), 0);
    }
}
